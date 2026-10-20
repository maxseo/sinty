import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Sinty } from "../sinty.js";
import { boot, tempHome } from "./helpers.js";

const script = {
  ask: [{ toolCalls: [{ name: "models__ask", args: { text: "say cheap" } }] }, { text: "done" }],
  "ask default": [{ toolCalls: [{ name: "models__ask", args: { text: "say cheap", route: "default" } }] }, { text: "done" }],
  vec: [{ toolCalls: [{ name: "models__vec", args: { texts: ["alpha", "beta"] } }] }, { text: "done" }],
  "say cheap": [{ text: "cheap answer" }],
};

function config(extra: Record<string, unknown> = {}) {
  return {
    providers: { rec: { protocol: "rec", options: { script, dims: 4 } } },
    models: { default: "rec/main-model", fallback: [], routes: { cheap: "rec/cheap-model", embed: "rec/embed-model" }, catalog: [], maxOutputTokens: 1000, ...extra },
  };
}

function results(sinty: Sinty, sessionId: string): unknown[] {
  return sinty.journal.events(sessionId).filter((e) => e.type === "tool.call.completed" || e.type === "tool.call.failed").map((e) => e.data);
}

test("ctx.models: complete and embed through the core, journaled, permission and budget enforced", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: config({ pluginTokensPerDay: 40 }), plugins: ["recording-provider", "models-user"] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "ask");
    await sinty.agent.idle();
    const [ok] = results(sinty, s.id) as { result: { text: string; model: string } }[];
    assert.equal(ok!.result.text, "cheap answer");
    assert.equal(ok!.result.model, "cheap-model");
    const called = sinty.journal.events(s.id).filter((e) => e.type === "models.called");
    assert.equal(called.length, 1);
    assert.equal((called[0]!.data as { route: string; plugin: string }).route, "cheap");
    assert.equal((called[0]!.data as { plugin: string }).plugin, "models-user");
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "usage.recorded" && e.actor.kind === "plugin"));

    const d = sinty.agent.createSession();
    sinty.agent.send(d.id, "ask default");
    await sinty.agent.idle();
    const [denied] = results(sinty, d.id) as { code: string }[];
    assert.equal(denied!.code, "models_denied");

    const v = sinty.agent.createSession();
    sinty.agent.send(v.id, "vec");
    await sinty.agent.idle();
    const [vec] = results(sinty, v.id) as { result: { n: number; width: number } }[];
    assert.deepEqual(vec!.result, { n: 2, width: 4, model: "embed-model" });

    // 15 (complete) + 10 (embed) = 25 tokens; the next complete reaches 40 = the budget, later calls fail
    for (let i = 0; i < 3; i++) {
      const b = sinty.agent.createSession();
      sinty.agent.send(b.id, "ask");
      await sinty.agent.idle();
    }
    const last = sinty.agent.createSession();
    sinty.agent.send(last.id, "ask");
    await sinty.agent.idle();
    const [over] = results(sinty, last.id) as { code: string }[];
    assert.equal(over!.code, "models_budget");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("model gateway: routes resolve default, cheap and embed", async () => {
  const { home, cleanup } = tempHome();
  const sinty = new Sinty({ home, config: { ...config(), service: { model: "rec/service-model", compress: "", facts: "" } } });
  try {
    assert.deepEqual(sinty.models.resolve("default"), ["rec/main-model"]);
    assert.deepEqual(sinty.models.resolve("cheap"), ["rec/cheap-model"]);
    assert.deepEqual(sinty.models.resolve("embed"), ["rec/embed-model"]);
    assert.deepEqual(sinty.models.resolve("other/model"), ["other/model"]);
    assert.deepEqual(sinty.models.resolve("nope"), []);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("provider-openai-compat: embed() posts to /embeddings and keeps input order", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ url: req.url, auth: req.headers.authorization, ...(JSON.parse(raw) as Record<string, unknown>) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 6 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const sinty = new Sinty({
    home,
    config: {
      providers: { oa: { protocol: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key" } },
      models: { default: "oa/chat", fallback: [], routes: { embed: "oa/text-embedding-test" }, catalog: [], maxOutputTokens: 1000 },
      plugins: { enabled: ["provider-openai-compat"], config: {}, searchPaths: [] },
    },
  });
  try {
    const { failedPlugins } = await sinty.start();
    assert.deepEqual(failedPlugins, []);
    const r = await sinty.models.embed({ input: ["first", "second"] });
    assert.deepEqual(r.vectors, [[1, 0], [0, 1]]);
    assert.equal(r.model, "text-embedding-test");
    assert.deepEqual(r.usage, { inputTokens: 6 });
    assert.equal(bodies[0]?.url, "/v1/embeddings");
    assert.equal(bodies[0]?.auth, "Bearer test-key");
    assert.deepEqual(bodies[0]?.input, ["first", "second"]);
  } finally {
    await sinty.stop();
    server.close();
    cleanup();
  }
});
