import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChatMessage, ContextSnapshot } from "@sinty/sdk";
import type { SintyConfig } from "../config.js";
import { parseManifest } from "../host/manifest.js";
import { diffMessages, inspectStats, redactPatterns } from "../inspect.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function cfg(script: Record<string, Step[]>, plugins: string[], extra: Partial<SintyConfig> = {}, inspect?: string[]): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", ...plugins], config: {}, searchPaths: [FIXTURES], ...(inspect ? { inspect } : {}) },
    ...extra,
  };
}

function lines<T>(file: string): T[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

const chatRequests = (home: string): { messages: ChatMessage[] }[] =>
  lines<{ messages?: ChatMessage[] }>(join(home, "data", "recording-provider", "requests.jsonl")).filter((r): r is { messages: ChatMessage[] } => Array.isArray(r.messages));

async function snapshots(home: string, plugin: string, want: number): Promise<ContextSnapshot[]> {
  const file = join(home, "data", plugin, "snapshots.jsonl");
  for (let i = 0; i < 100 && lines(file).length < want; i++) await sleep(20);
  return lines<ContextSnapshot>(file);
}

const write = { name: "memory__write", args: { text: "Deploy goes through staging first.", tier: "profile", scope: "user", about: "work" } };
const note = { name: "memory__write", args: { text: "The staging cluster lives in Frankfurt.", tier: "note", scope: "user", about: "work" } };

test("context snapshot: one per model step, messages identical to the provider request, every part labelled", async () => {
  const { home, cleanup } = tempHome();
  const config = cfg({ remember: [{ toolCalls: [write, note] }, { text: "stored" }] }, ["inspect-test"], { memory: { contextTokens: 128000, dimensions: 1536, recall: { auto: true } } }, ["inspect-test"]);
  config.plugins!.config = { "inspect-test": { note: true, block: true } };
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    assert.deepEqual(sinty.host.inspectors().map((p) => p.name), ["inspect-test"]);
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "remember");
    await sinty.agent.idle();
    sinty.agent.send(s.id, "staging");
    await sinty.agent.idle();
    const requests = chatRequests(home);
    assert.equal(requests.length, 3);
    const snaps = await snapshots(home, "inspect-test", 3);
    assert.equal(snaps.length, 3);
    snaps.forEach((snap, i) => assert.deepEqual(snap.messages, requests[i]!.messages, `step ${i} differs from what the provider got`));
    assert.deepEqual(snaps.map((x) => x.step), [1, 2, 1]);
    assert.equal(new Set(snaps.map((x) => x.id)).size, 3);
    assert.equal(snaps[0]!.turnId, snaps[1]!.turnId);
    assert.notEqual(snaps[1]!.turnId, snaps[2]!.turnId);
    const steps = sinty.journal.events(s.id).filter((e) => e.type === "model.request").map((e) => e.stepId);
    assert.deepEqual(snaps.map((x) => x.stepId), steps);

    const last = snaps[2]!;
    assert.equal(last.parts.length, last.messages.length);
    const kinds = last.parts.map((p) => p.kind);
    assert.equal(kinds[0], "system");
    assert.equal(kinds[1], "skills");
    assert.equal(last.parts[2]!.id, "memory.profile");
    assert.match(last.messages[2]!.content, /Deploy goes through staging first/);
    const recall = last.parts.find((p) => p.kind === "recall");
    assert.equal(recall?.id, "memory.recalled");
    const extra = last.parts.find((p) => p.id === "inspect.extra");
    assert.equal(extra?.kind, "processor");
    assert.equal(extra?.source, "inspect-test");
    const notePart = last.parts.find((p) => p.kind === "plugin");
    assert.equal(notePart?.source, "inspect-test");
    assert.equal(notePart?.id, "inspect-test/note");
    assert.ok(kinds.includes("dialogue"));
    // Tokens: per part, by kind, totals.
    const sum = last.parts.reduce((n, p) => n + p.tokens, 0);
    assert.equal(Object.values(last.tokens.byKind).reduce((n, v) => n + (v ?? 0), 0), sum);
    assert.equal(last.tokens.total, last.tokens.messages + last.tokens.tools);
    assert.ok(last.tools.some((t) => t.name === "memory__write" && t.tokens > 0));
    // Memory detail.
    assert.deepEqual(last.memory.facts.find((f) => f.tier === "profile") && [last.memory.facts[0]!.text, last.memory.facts[0]!.scope, last.memory.facts[0]!.source], ["Deploy goes through staging first.", "user", "agent"]);
    assert.equal(last.memory.recall?.cached, false);
    assert.deepEqual(last.memory.recall?.queries, ["staging"]);
    assert.equal(last.memory.recall?.records[0]?.text, "The staging cluster lives in Frankfurt.");
    assert.match(last.messages[last.parts.find((p) => p.kind === "recall")!.index]!.content, /Frankfurt/);
    assert.equal(snaps[1]!.memory.recall?.cached, true, "later steps reuse the turn's recall");
    const hook = last.memory.hooks.find((h) => h.hook === "beforeContext");
    assert.deepEqual([hook?.plugin, hook?.ok, hook?.changed], ["inspect-test", true, true]);
    assert.ok(hook?.after?.includes("inspect.extra"));
    // Plugin context contributor diff.
    assert.equal(last.contexts.length, 1);
    assert.equal(last.contexts[0]!.added.length, 1);
    assert.equal(last.contexts[0]!.added[0]!.content, "[inspect-test] house rule: answer briefly");
    assert.equal(last.contexts[0]!.removed.length, 0);
    assert.ok(last.contexts[0]!.tokensAfter > last.contexts[0]!.tokensBefore);
    assert.equal(last.redactions, 0);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("context snapshot: none without both the manifest permission and config plugins.inspect; nothing is built", async () => {
  for (const variant of [
    { plugins: ["inspect-test"], inspect: undefined, dir: "inspect-test" },
    { plugins: ["inspect-test"], inspect: ["other"], dir: "inspect-test" },
    { plugins: ["inspect-noperm"], inspect: ["inspect-noperm"], dir: "inspect-noperm" },
  ]) {
    const { home, cleanup } = tempHome();
    const sinty = await boot(home, [], { config: cfg({}, variant.plugins, {}, variant.inspect), plugins: [] });
    try {
      assert.deepEqual(sinty.host.inspectors(), []);
      const before = inspectStats.built;
      const s = sinty.agent.createSession();
      sinty.agent.send(s.id, "hello");
      await sinty.agent.idle();
      assert.equal(chatRequests(home).length, 1);
      await sleep(100);
      assert.equal(existsSync(join(home, "data", variant.dir, "snapshots.jsonl")), false, JSON.stringify(variant));
      assert.equal(inspectStats.built, before, "no snapshot is even built without an inspector");
    } finally {
      await sinty.stop();
      cleanup();
    }
  }
});

test("context snapshot: known secrets and secret-looking strings are redacted", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: cfg({}, ["inspect-test"], {}, ["inspect-test"]), plugins: [] });
  try {
    sinty.secrets.set("demo.token", "hunter2-very-secret");
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "my key is hunter2-very-secret and sk-abcdefghijklmnopqrstuvwxyz0123");
    await sinty.agent.idle();
    const [snap] = await snapshots(home, "inspect-test", 1);
    // The journal already masks known secret values; secret-looking strings reach the provider and are masked only here.
    const sent = chatRequests(home)[0]!.messages;
    assert.ok(sent.some((m) => m.content.includes("sk-abcdefghijklmnopqrstuvwxyz0123")));
    const text = JSON.stringify(snap);
    assert.equal(text.includes("hunter2-very-secret"), false);
    assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz0123"), false);
    assert.ok(snap!.messages.some((m) => m.content === "my key is [redacted] and [redacted]"));
    assert.ok(snap!.redactions >= 1);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("redactPatterns and diffMessages", () => {
  assert.equal(redactPatterns("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [redacted]");
  assert.equal(redactPatterns("ghp_0123456789abcdefghijABCDEFGHIJ and AKIAABCDEFGHIJKLMNOP"), "[redacted] and [redacted]");
  assert.equal(redactPatterns("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), "[redacted]");
  assert.equal(redactPatterns("plain words and sk-short"), "plain words and sk-short");
  const a: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "user", content: "u" }];
  const b: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "system", content: "new" }];
  const d = diffMessages(a, b);
  assert.deepEqual(d.added, [{ index: 2, role: "system", content: "new" }]);
  assert.deepEqual(d.removed, [{ index: 2, role: "user", content: "u" }]);
});

test("manifest: ui.tabs and permissions.context are validated", () => {
  const base = { name: "tabby", version: "1.0.0", description: "d", kinds: ["ui"], runtime: "node", entry: "i.js", permissions: {} };
  const ok = parseManifest({ ...base, permissions: { context: ["inspect"] }, ui: { tabs: [{ id: "main", title: "Main", path: "/tab" }, { id: "two", title: "Two", path: "/pages/two.html" }] } });
  assert.equal(ok.ui?.tabs?.length, 2);
  assert.equal(parseManifest({ ...base, ui: { static: "public" } }).ui?.static, "public");
  const bad: unknown[] = [
    { ui: {} },
    { ui: { tabs: [] } },
    { ui: { tabs: [{ id: "Main", title: "x", path: "/tab" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "tab" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "/../v1/sessions" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "/a/./b" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "https://evil.example/tab" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "/tab?x=1" }] } },
    { ui: { tabs: [{ id: "a", title: "", path: "/tab" }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "/tab", extra: 1 }] } },
    { ui: { tabs: [{ id: "a", title: "x", path: "/a" }, { id: "a", title: "y", path: "/b" }] } },
    { permissions: { context: ["write"] } },
  ];
  for (const b of bad) assert.throws(() => parseManifest({ ...base, ...(b as object) }), Error, JSON.stringify(b));
});
