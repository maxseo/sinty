import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { boot, find, FIXTURES, tempHome } from "./helpers.js";

test("http mcp plugin tools go through the turn", async () => {
  const server = await listen();
  const root = mkdtempSync(join(tmpdir(), "sinty-mcp-http-"));
  const dir = join(root, "mcp-http");
  mkdirSync(dir);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(
    join(dir, "sinty.plugin.json"),
    JSON.stringify({
      name: "mcp-http",
      version: "0.0.1",
      description: "fixture http mcp",
      kinds: ["tool"],
      runtime: "http",
      url: `http://127.0.0.1:${port}/`,
      permissions: { net: ["127.0.0.1"] },
    }),
  );
  const { home, cleanup } = tempHome();
  let sinty: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    sinty = await boot(home, [{ toolCalls: [{ name: "mcp-http__ping", args: { text: "pong" } }] }, { text: "done" }], {
      policy: policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" }, net: { allow: ["127.0.0.1"] } }),
      plugins: ["fake-provider", "mcp-http"],
      config: { plugins: { enabled: ["fake-provider", "mcp-http"], config: {}, searchPaths: [FIXTURES, root] } },
    });
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "ping");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal(find<{ result: unknown }>(events, "tool.call.completed")?.result, "pong");
  } finally {
    await sinty?.stop();
    cleanup();
    rmSync(root, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

function listen(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown = {};
      if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "0" } };
      if (msg.method === "tools/list") result = { tools: [{ name: "ping", description: "echo the text" }] };
      if (msg.method === "tools/call") result = { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
