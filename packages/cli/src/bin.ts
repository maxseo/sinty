#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { BusMessage, LogFn } from "@sinty/core";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!(w.name === "ExperimentalWarning" && /SQLite/.test(w.message))) console.warn(w);
});
const { initHome, resolvePaths, SecretStore, Sinty, startServer } = await import("@sinty/core");

const HELP = `sinty — thin-core AI agent

Usage:
  sinty init                       create $SINTY_HOME (default ~/.sinty)
  sinty run "<prompt>" [--session <id>] [--yes]
                                   one turn in the terminal; --yes approves every ask
  sinty serve [--port 3180] [--host 127.0.0.1]
                                   HTTP API (alias: web)
  sinty secret set <name> [value]  value from stdin when omitted
  sinty secret list | rm <name>
  sinty doctor                     check config, secrets and plugins

Global: --home <dir>, --verbose`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    session: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    yes: { type: "boolean", short: "y" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
const log: LogFn = (level, msg, data) => {
  if (!values.verbose && (level === "debug" || level === "info")) return;
  process.stderr.write(`[${level}] ${msg}${data === undefined ? "" : ` ${typeof data === "string" ? data : JSON.stringify(data)}`}\n`);
};

async function main(): Promise<number> {
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "init":
      return init();
    case "run":
      return run(rest.join(" "));
    case "serve":
    case "web":
      return serveCmd();
    case "secret":
      return secret(rest);
    case "doctor":
      return doctor();
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

function init(): number {
  const r = initHome(values.home);
  console.log(`Sinty home: ${r.paths.home}`);
  for (const c of r.created) console.log(`  created ${c}`);
  if (r.apiToken) console.log(`\nAPI token (stored as secret api.token, shown once):\n  ${r.apiToken}`);
  console.log(`\nNext:\n  1. sinty secret set deepseek      (or anthropic, openai, xai)\n  2. set models.default in ${r.paths.config}, e.g. deepseek/deepseek-chat\n  3. sinty run "hello"`);
  return 0;
}

async function run(prompt: string): Promise<number> {
  if (!prompt.trim()) {
    console.error('usage: sinty run "<prompt>"');
    return 2;
  }
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  const started = await sinty.start();
  if (started.failedPlugins.length) for (const f of started.failedPlugins) console.error(`plugin ${f.plugin}: ${f.error}`);
  const sessionId = values.session ?? sinty.agent.createSession({ title: prompt.slice(0, 80) }).id;
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;

  let exit = 0;
  const finished = new Promise<void>((resolveDone) => {
    sinty.bus.subscribe((m: BusMessage) => {
      if (m.event.sessionId !== sessionId) return;
      if (m.kind === "stream") {
        if (m.event.type === "model.delta" && m.event.data.text) process.stdout.write(m.event.data.text);
        return;
      }
      const e = m.event;
      switch (e.type) {
        case "tool.call.started":
          process.stderr.write(`\n  → ${(e.data as { tool: string }).tool}\n`);
          break;
        case "tool.call.failed": {
          const d = e.data as { code: string; message: string };
          process.stderr.write(`  ✗ ${d.code}: ${d.message}\n`);
          break;
        }
        case "tool.call.approval_requested": {
          const d = e.data as { callId: string; tool: string; args: unknown; reason: string };
          void (async () => {
            let ok = Boolean(values.yes);
            if (!ok && rl) ok = /^y/i.test(await rl.question(`\n  ? ${d.tool} ${JSON.stringify(d.args).slice(0, 300)}\n    approve (${d.reason})? [y/N] `));
            sinty.agent.decide(sessionId, d.callId, ok ? "approve" : "deny", { kind: "human", id: "cli" });
          })();
          break;
        }
        case "supervisor.notice":
          process.stderr.write(`  ! supervisor: ${(e.data as { text: string }).text.split("\n")[0]}\n`);
          break;
        case "plugin.patch.applied":
        case "plugin.patch.rolled_back":
          process.stderr.write(`  ~ ${e.type.replace("plugin.patch.", "patch ")}: ${JSON.stringify(e.data)}\n`);
          break;
        case "turn.blocked": {
          const d = e.data as { reason: string; detail?: string };
          if (d.reason !== "approval") {
            void (async () => {
              const prompt = d.reason === "ask_human" ? `agent asks: ${d.detail ?? ""}` : `${d.reason === "budget" ? "budget" : "supervisor"} stopped the turn: ${d.detail ?? ""}`;
              if (!rl) {
                console.error(`\n${prompt} (no TTY, stopping)`);
                exit = 3;
                resolveDone();
                return;
              }
              const answer = await rl.question(`\n  ? ${prompt}\n  > `);
              sinty.agent.send(sessionId, answer);
            })();
          }
          break;
        }
        case "turn.completed":
          process.stdout.write("\n");
          resolveDone();
          break;
        case "turn.failed": {
          const d = e.data as { code: string; message: string };
          console.error(`\nturn failed: ${d.code}: ${d.message}`);
          exit = 1;
          resolveDone();
          break;
        }
        case "turn.interrupted":
          exit = 130;
          resolveDone();
          break;
      }
    });
  });

  process.once("SIGINT", () => void sinty.agent.interrupt(sessionId));
  sinty.agent.send(sessionId, prompt, { channel: "cli" });
  await finished;
  rl?.close();
  await sinty.stop();
  console.error(`session ${sessionId}`);
  return exit;
}

async function serveCmd(): Promise<number> {
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  const started = await sinty.start();
  for (const f of started.failedPlugins) console.error(`plugin ${f.plugin}: ${f.error}`);
  if (started.resumedTurns.length) console.error(`resumed ${started.resumedTurns.length} turn(s)`);
  const { url } = await startServer(sinty, {
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
  });
  console.log(`Sinty API on ${url}\nAuth: Authorization: Bearer <token printed by sinty init>`);
  const shutdown = (): void => {
    void sinty.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return new Promise<number>(() => undefined);
}

async function secret(args: string[]): Promise<number> {
  const paths = resolvePaths(values.home);
  const store = new SecretStore(paths);
  const [sub, name, value] = args;
  if (sub === "list") {
    for (const n of store.names()) console.log(n);
    return 0;
  }
  if (sub === "rm" && name) {
    console.log(store.delete(name) ? `removed ${name}` : `${name} not found`);
    return 0;
  }
  if (sub === "set" && name) {
    const v = value ?? (await readSecretFromStdin(name));
    if (!v) {
      console.error("empty value");
      return 2;
    }
    store.set(name, v);
    console.log(`stored ${name}`);
    return 0;
  }
  console.error("usage: sinty secret set <name> [value] | list | rm <name>");
  return 2;
}

async function readSecretFromStdin(name: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const v = await rl.question(`${name}: `);
  rl.close();
  return v.trim();
}

async function doctor(): Promise<number> {
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  let problems = 0;
  const check = (ok: boolean, text: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
    if (!ok) problems++;
  };
  console.log(`home     ${sinty.paths.home}\ninstall  ${sinty.paths.install}\n`);
  const def = sinty.config.models.default;
  check(Boolean(def), `models.default = ${def || "(empty)"}`);
  for (const route of [def, ...sinty.config.models.fallback].filter((r): r is string => Boolean(r))) {
    const pid = route.split("/")[0]!;
    const p = sinty.config.providers[pid];
    check(Boolean(p), `provider ${pid} configured`);
    if (p?.apiKey) check(Boolean(sinty.secrets.resolve(p.apiKey)), `secret for ${pid} (${p.apiKey})`);
  }
  check(Boolean(sinty.secrets.resolve(sinty.config.server.token)), "API token");
  const started = await sinty.start();
  for (const p of sinty.host.plugins.values()) check(true, `plugin ${p.name}: ${p.tools.length} tools, providers [${p.providers.join(", ")}]`);
  for (const f of started.failedPlugins) check(false, `plugin ${f.plugin}: ${f.error}`);
  await sinty.stop();
  console.log(problems ? `\n${problems} problem(s)` : "\nall good");
  return problems ? 1 : 0;
}

main().then(
  (code) => {
    if (command !== "serve" && command !== "web") process.exit(code);
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
