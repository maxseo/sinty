#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { BusMessage, LogFn } from "@sinty/core";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!(w.name === "ExperimentalWarning" && /SQLite/.test(w.message))) console.warn(w);
});
const { evalMemory, formatEval, checkIntegrity, hashInstall, initHome, loadConfig, loadRegistry, PROTOCOL_VERSION, readIntegrity, resolvePaths, rotateApiToken, SecretStore, Sinty, startServer, TokenRotationError } = await import("@sinty/core");

const HELP = `sinty — thin-core AI agent

Usage:
  sinty init                       create $SINTY_HOME (default ~/.sinty)
  sinty run "<prompt>" [--session <id>] [--yes]
                                   one turn in the terminal; --yes approves every ask
  sinty serve | web [--port 3180] [--host 127.0.0.1]
                                   HTTP API and Web UI; prints a login URL with #token=
  sinty secret set <name> [value]  value from stdin when omitted
  sinty secret list | rm <name>
  sinty token                      print the login token (for scripts: Authorization: Bearer …)
  sinty token rotate [--print]     new login token; the old one stops working at once, also in a
                                   running server; --print writes the new token to stdout
  sinty doctor                     check config, secrets, plugins and install integrity
  sinty upgrade --from <dir>      replace this install with a tree whose integrity.json matches
  sinty version
  sinty plugins                     catalog from registry/plugins.json and whether each is enabled
  sinty memory eval [--labels file.jsonl] [--arms a,b] [--limit 200] [--json]
                                   offline recall replay: hit rate on labeled queries, memory-block
                                   tokens and recall latency per arm (no chat model calls)
  sinty memory reindex [--dry-run] [--batch 64] [--json]
                                   embed facts that have no vector yet (models.routes.embed);
                                   idempotent, safe to rerun after an interruption

Global: --home <dir>, --mode strict, --verbose`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    session: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    yes: { type: "boolean", short: "y" },
    mode: { type: "string" },
    from: { type: "string" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
    labels: { type: "string" },
    arms: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
    "dry-run": { type: "boolean" },
    print: { type: "boolean" },
    batch: { type: "string" },
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
    case "token":
      return tokenCmd(rest);
    case "doctor":
      return doctor();
    case "upgrade":
      return upgrade();
    case "version":
      return version();
    case "plugins":
      return plugins();
    case "memory":
      return memoryCmd(rest);
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

function init(): number {
  const r = initHome(values.home);
  console.log(`Sinty home: ${r.paths.home}`);
  for (const c of r.created) console.log(`  created ${c}`);
  if (values.mode === "strict") {
    const text = readFileSync(r.paths.policy, "utf8").replace(/^mode:\s*\S+/m, "mode: strict");
    writeFileSync(r.paths.policy, text);
    console.log("policy mode: strict");
  }
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
  const apiToken = sinty.secrets.resolve(sinty.config.server.token);
  const ui = sinty.config.server.ui;
  console.log(`Sinty API  ${url}`);
  if (apiToken) console.log(`Web UI     ${url}/ui/${ui}/#token=${encodeURIComponent(apiToken)}`);
  else console.log(`Web UI     ${url}/ui/${ui}/  (set the API token: sinty init)`);
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

function tokenCmd(args: string[]): number {
  const paths = resolvePaths(values.home);
  const config = loadConfig(paths);
  const store = new SecretStore(paths);
  const [sub] = args;
  if (sub === undefined) {
    const t = store.resolve(config.server.token);
    if (!t) {
      console.error("no login token: run sinty init");
      return 1;
    }
    console.log(t);
    return 0;
  }
  if (sub === "rotate") {
    try {
      const t = rotateApiToken(store, config);
      if (values.print) console.log(t);
      console.error(
        "login token rotated: the old one no longer works; open Sinty again with the link from `sinty web`" +
          (values.print ? "" : " (or print the new token with `sinty token`)"),
      );
      return 0;
    } catch (e) {
      if (e instanceof TokenRotationError) {
        console.error(`cannot rotate: ${e.message}. ${e.hint}`);
        return 1;
      }
      throw e;
    }
  }
  console.error("usage: sinty token [rotate [--print]]");
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

function version(): number {
  const integrity = readIntegrity(resolvePaths(values.home).install);
  console.log(`protocol ${PROTOCOL_VERSION}`);
  console.log(integrity ? `sinty install, ${Object.keys(integrity.files).length} hashed files` : "sinty (source tree, no integrity.json)");
  return 0;
}

function plugins(): number {
  const paths = resolvePaths(values.home);
  let enabled = new Set<string>();
  try {
    enabled = new Set(new Sinty({ ...(values.home ? { home: values.home } : {}) }).config.plugins.enabled);
  } catch {
    /* home may be missing; still print the catalog */
  }
  const list = loadRegistry(paths);
  if (!list.length) {
    console.log("no registry/plugins.json in this install");
    return 1;
  }
  for (const p of list) console.log(`${enabled.has(p.name) ? "on " : "off"}  ${p.name.padEnd(28)} ${p.version.padEnd(8)} ${p.kinds.join(", ")}`);
  console.log("\nTurn one on: add its name to plugins.enabled in config.yaml, then restart sinty web.");
  return 0;
}

function upgrade(): number {
  const from = values.from;
  if (!from) {
    console.error("usage: sinty upgrade --from <directory with integrity.json>");
    return 2;
  }
  const source = checkIntegrity(from);
  if (!readIntegrity(from)) {
    console.error(`${from} has no integrity.json; build it with node scripts/stage.mjs`);
    return 1;
  }
  if (!source.ok) {
    console.error(`source failed the integrity check:\n${source.problems.slice(0, 8).join("\n")}`);
    return 1;
  }
  const install = resolvePaths(values.home).install;
  const files = hashInstall(from);
  for (const rel of Object.keys(files)) {
    const dest = join(install, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(from, rel), dest);
  }
  cpSync(join(from, "integrity.json"), join(install, "integrity.json"));
  console.log(`upgraded ${install} (${Object.keys(files).length} files)`);
  return 0;
}

async function doctor(): Promise<number> {
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  let problems = 0;
  const check = (ok: boolean, text: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
    if (!ok) problems++;
  };
  console.log(`home     ${sinty.paths.home}\ninstall  ${sinty.paths.install}\nmode     ${sinty.policy.mode}`);
  const integrity = checkIntegrity(sinty.paths.install);
  check(integrity.ok, integrity.ok ? "install integrity" : `install integrity (${integrity.problems[0] ?? "mismatch"})`);
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
  if (def) {
    // Ask the provider's model list now instead of waiting for the background refresh.
    await sinty.windows.refresh(def.split("/")[0]!);
    const w = sinty.windows.resolve(def);
    console.log(`info context window ${def}: ${w.tokens} tokens (${w.source}${w.source === "fallback" ? ": unknown model, set models.contextWindows or memory.contextTokens" : ""}), summary at ${Math.floor(w.tokens * 0.65)}`);
  }
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

async function memoryReindex(): Promise<number> {
  const batch = values.batch ? Number(values.batch) : 64;
  if (!Number.isInteger(batch) || batch < 1) {
    console.error("--batch must be a positive integer");
    return 2;
  }
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  try {
    const { failedPlugins } = await sinty.start({ background: false });
    for (const f of failedPlugins) console.error(`plugin ${f.plugin} failed to start: ${f.error}`);
    const tty = process.stderr.isTTY && !values.json;
    const r = await sinty.memory.reindexVectors({
      dryRun: values["dry-run"] === true,
      batchSize: batch,
      onProgress: ({ done, total }) => {
        if (!values.json) process.stderr.write(tty ? `\rembedded ${done}/${total}` : `embedded ${done}/${total}\n`);
      },
    });
    if (tty && r.embedded) process.stderr.write("\n");
    if (values.json) console.log(JSON.stringify(r));
    else if (r.dryRun) console.log(`${r.total} fact(s) have no vector; run without --dry-run to embed them`);
    else console.log(r.total ? `embedded ${r.embedded} of ${r.total} fact(s)` : "every fact already has a vector");
    return r.embedded < r.total && !r.dryRun ? 1 : 0;
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    console.error(`reindex failed: ${err.message ?? String(e)}${err.hint ? `\n${err.hint}` : ""}`);
    return 1;
  } finally {
    await sinty.stop();
  }
}

async function memoryCmd(args: string[]): Promise<number> {
  if (args[0] === "reindex") return memoryReindex();
  if (args[0] !== "eval") {
    console.error("usage: sinty memory eval [--labels file.jsonl] [--arms a,b] [--limit 200] [--json]\n       sinty memory reindex [--dry-run] [--batch 64] [--json]");
    return 2;
  }
  const labels = values.labels
    ? readFileSync(values.labels, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l, i) => {
          const row = JSON.parse(l) as { query?: unknown; expect?: unknown };
          if (typeof row.query !== "string" || !Array.isArray(row.expect)) throw new Error(`${values.labels}:${i + 1}: need {"query": "...", "expect": ["..."]}`);
          return { query: row.query, expect: row.expect.map(String) };
        })
    : undefined;
  const sinty = new Sinty({ ...(values.home ? { home: values.home } : {}), log });
  try {
    const { failedPlugins } = await sinty.start({ background: false });
    for (const f of failedPlugins) console.error(`plugin ${f.plugin} failed to start: ${f.error}`);
    const reports = await evalMemory(sinty, {
      ...(labels ? { labels } : {}),
      ...(values.arms ? { arms: values.arms.split(",").map((a) => a.trim()).filter(Boolean) } : {}),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
    });
    console.log(values.json ? JSON.stringify(reports, null, 2) : formatEval(reports));
    return 0;
  } finally {
    await sinty.stop();
  }
}
