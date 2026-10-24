import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { installMcpPlugin, McpInstallError } from "../mcp-install.js";
import { FIXTURES, boot, find, tempHome } from "./helpers.js";

const ECHO_SERVER = join(FIXTURES, "mcp-echo", "server.mjs");

test("mcp.install: writes home plugin, enables, hot-starts stdio fixture tools", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    const result = await installMcpPlugin(sinty.paths, sinty.config, sinty.host, {
      name: "mcp-installed",
      description: "installed echo",
      runtime: "mcp-stdio",
      command: ["node", ECHO_SERVER],
    });
    assert.equal(result.name, "mcp-installed");
    assert.equal(result.runtime, "mcp-stdio");
    assert.equal(result.started, true);
    assert.ok(result.tools.includes("mcp-installed.ping"));
    assert.ok(existsSync(join(home, "plugins", "mcp-installed", "sinty.plugin.json")));
    assert.ok(sinty.config.plugins.enabled.includes("mcp-installed"));
    assert.match(readFileSync(sinty.paths.config, "utf8"), /mcp-installed/);
    assert.ok(sinty.host.toolOwner("mcp-installed.ping"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("mcp.install: rejects bad name, bundled overwrite, and existing folder without replace", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider", "tool-fs"] });
  try {
    await assert.rejects(
      () => installMcpPlugin(sinty.paths, sinty.config, sinty.host, { name: "../evil", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] }),
      (e: unknown) => e instanceof McpInstallError && e.code === "bad_name",
    );
    await assert.rejects(
      () => installMcpPlugin(sinty.paths, sinty.config, sinty.host, { name: "TOOL-FS", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] }),
      (e: unknown) => e instanceof McpInstallError && e.code === "bad_name",
    );
    await assert.rejects(
      () => installMcpPlugin(sinty.paths, sinty.config, sinty.host, { name: "tool-fs", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] }),
      (e: unknown) => e instanceof McpInstallError && e.code === "bundled",
    );

    await installMcpPlugin(sinty.paths, sinty.config, sinty.host, {
      name: "mcp-once",
      runtime: "mcp-stdio",
      command: ["node", ECHO_SERVER],
    });
    await assert.rejects(
      () => installMcpPlugin(sinty.paths, sinty.config, sinty.host, { name: "mcp-once", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] }),
      (e: unknown) => e instanceof McpInstallError && e.code === "exists",
    );

    const replaced = await installMcpPlugin(sinty.paths, sinty.config, sinty.host, {
      name: "mcp-once",
      description: "replaced",
      runtime: "mcp-stdio",
      command: ["node", ECHO_SERVER],
      replace: true,
    });
    assert.equal(replaced.started, true);
    assert.match(readFileSync(join(home, "plugins", "mcp-once", "sinty.plugin.json"), "utf8"), /"replaced"/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("mcp.install: refuses raw env secret values; accepts secret:// refs without echoing them", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    sinty.secrets.set("github.token", "super-secret-value-do-not-leak");
    await assert.rejects(
      () =>
        installMcpPlugin(sinty.paths, sinty.config, sinty.host, {
          name: "mcp-sec",
          runtime: "mcp-stdio",
          command: ["node", ECHO_SERVER],
          env: { GITHUB_TOKEN: "super-secret-value-do-not-leak" },
        }),
      (e: unknown) => e instanceof McpInstallError && e.code === "bad_request",
    );

    const result = await installMcpPlugin(sinty.paths, sinty.config, sinty.host, {
      name: "mcp-sec",
      runtime: "mcp-stdio",
      command: ["node", ECHO_SERVER],
      env: { GITHUB_TOKEN: "secret://github.token" },
      permissions: { secrets: ["secret://github.token"] },
    });
    assert.equal(result.started, true);
    const manifest = readFileSync(join(home, "plugins", "mcp-sec", "sinty.plugin.json"), "utf8");
    const configYaml = readFileSync(sinty.paths.config, "utf8");
    assert.doesNotMatch(manifest, /super-secret-value-do-not-leak/);
    assert.doesNotMatch(configYaml, /super-secret-value-do-not-leak/);
    assert.match(configYaml, /secret:\/\/github\.token/);
    assert.match(manifest, /"github\.token"/);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value-do-not-leak/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("POST /v1/plugins/mcp: 401 without auth; installs with bearer", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    const app = createApp(sinty);
    assert.equal((await app.request("/v1/plugins/mcp", { method: "POST", body: "{}" })).status, 401);

    const token = sinty.secrets.get("api.token")!;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const res = await app.request("/v1/plugins/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "mcp-api", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { name: string; tools: string[]; started: boolean };
    assert.equal(body.name, "mcp-api");
    assert.equal(body.started, true);
    assert.ok(body.tools.includes("mcp-api.ping"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("mcp.install tool: policy ask blocks until approved, then tools appear", async () => {
  const { home, cleanup } = tempHome();
  // Default policy: external is ask; mcp.install is also listed as ask in DEFAULT_POLICY_YAML.
  const sinty = await boot(
    home,
    [
      {
        toolCalls: [
          {
            name: "mcp__install",
            args: { name: "mcp-via-tool", runtime: "mcp-stdio", command: ["node", ECHO_SERVER] },
          },
        ],
      },
      { toolCalls: [{ name: "mcp-via-tool__ping", args: { text: "hi" } }] },
      { text: "done" },
    ],
    {
      plugins: ["fake-provider"],
      // Keep mcp.install on ask; allow other external tools (the new MCP ping) so the turn can finish.
      policy: policySchema.parse({
        defaults: { none: "allow", read: "allow", write: "allow", external: "allow" },
        tools: { "mcp.install": "ask" },
      }),
    },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "install echo mcp");
    await sinty.agent.idle();
    assert.equal(sinty.journal.activeTurn(s.id)?.status, "blocked");
    const req = find<{ callId: string; tool: string }>(sinty.journal.events(s.id), "tool.call.approval_requested")!;
    assert.equal(req.tool, "mcp.install");
    sinty.agent.decide(s.id, req.callId, "approve", { kind: "human", id: "test" });
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.ok(existsSync(join(home, "plugins", "mcp-via-tool", "sinty.plugin.json")));
    const completed = events.filter((e) => e.type === "tool.call.completed").map((e) => e.data as { result: unknown });
    assert.ok(completed.some((c) => c.result && typeof c.result === "object" && (c.result as { name?: string }).name === "mcp-via-tool"));
    assert.ok(completed.some((c) => c.result === "hi"), "ping after install");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
