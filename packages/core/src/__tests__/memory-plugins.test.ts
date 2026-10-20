import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SintyConfig } from "../config.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function requests(home: string): { messages: { role: string; content: string }[] }[] {
  const p = join(home, "data", "recording-provider", "requests.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { messages: { role: string; content: string }[] }) : [];
}

function cfg(script: Record<string, Step[]>, plugins: string[], extra: Partial<SintyConfig> = {}, options: Record<string, unknown> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script, ...options } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", ...plugins], config: {}, searchPaths: [FIXTURES] },
    ...extra,
  };
}

test("builtin vector search works when an embed route is configured", async () => {
  const { home, cleanup } = tempHome();
  const write = (text: string) => ({ name: "memory__write", args: { text, tier: "log", scope: "user", about: "work" } });
  const script = {
    seed: [{ toolCalls: [write("abab abab baba"), write("cdcd dcdc cdcd")] }, { text: "ok" }],
    find: [{ toolCalls: [{ name: "memory__recall", args: { query: "efef fefe" } }] }, { text: "ok" }],
  };
  const config = cfg(script, [], { memory: { contextTokens: 128000, dimensions: 4 }, models: { default: "rec/main", fallback: [], routes: { embed: "rec/emb" }, catalog: [], maxOutputTokens: 1000 } }, { dims: 4 });
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    assert.equal(sinty.memory.builtin.store.vec, true);
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "seed");
    await sinty.agent.idle();
    sinty.agent.send(s.id, "find");
    await sinty.agent.idle();
    const results = sinty.journal.events(s.id).filter((e) => e.type === "tool.call.completed").map((e) => (e.data as { result: unknown }).result);
    const found = results.at(-1) as { text: string }[];
    assert.ok(found.length >= 1, "no lexical overlap, found by vector");
    assert.equal(found[0]!.text, "abab abab baba");
    assert.equal(sinty.journal.events(s.id).some((e) => e.type === "memory.degraded"), false);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("a wrong embedding width degrades to full-text search once", async () => {
  const { home, cleanup } = tempHome();
  const script = { seed: [{ toolCalls: [{ name: "memory__write", args: { text: "Deploy goes through staging first.", tier: "log", scope: "user", about: "work" } }] }, { text: "ok" }] };
  const config = cfg(script, [], { memory: { contextTokens: 128000, dimensions: 8 }, models: { default: "rec/main", fallback: [], routes: { embed: "rec/emb" }, catalog: [], maxOutputTokens: 1000 } }, { dims: 4 });
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "seed");
    await sinty.agent.idle();
    const degraded = sinty.journal.events(s.id).filter((e) => e.type === "memory.degraded");
    assert.equal(degraded.length, 1);
    assert.match((degraded[0]!.data as { reason: string }).reason, /width 4, memory.dimensions is 8/);
    assert.equal(sinty.memory.builtin.recall({ query: "staging", chatId: s.id, agentId: "Sinty" }).length, 1);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("memory-obsidian: vault notes are recalled as untrusted records; the vault is read through $CONFIG.vault", async () => {
  const { home, cleanup } = tempHome();
  const vault = mkdtempSync(join(tmpdir(), "sinty-vault-"));
  mkdirSync(join(vault, "projects"), { recursive: true });
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "projects", "deploy.md"), "---\ntags: [ops]\n---\n# Deploy\n\nKubernetes rollout uses the blue-green strategy.\n\n## Rollback\n\nRun helm rollback with the previous revision.\n");
  writeFileSync(join(vault, "recipes.md"), "# Pancakes\n\nFlour, milk, eggs.\n");
  writeFileSync(join(vault, ".obsidian", "workspace.md"), "kubernetes kubernetes kubernetes");
  const config = cfg({}, ["memory-obsidian"], { memory: { contextTokens: 128000, dimensions: 1536, recall: { auto: true } } });
  config.plugins!.config = { "memory-obsidian": { vault } };
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "how do we do a kubernetes rollback?");
    await sinty.agent.idle();
    const block = requests(home)[0]!.messages.find((m) => m.content.startsWith("<turn_context>") && m.content.includes('<recalled_memory untrusted="true">'));
    assert.ok(block, "vault block in the prompt");
    assert.match(block.content, /\[memory-obsidian\] projects\/deploy\.md: deploy › Rollback: Run helm rollback/);
    assert.doesNotMatch(block.content, /Pancakes|workspace/);
    assert.ok(existsSync(join(home, "data", "memory-obsidian", "index.json")), "own index in $DATA");
    const recalled = sinty.journal.events(s.id).find((e) => e.type === "memory.recalled")?.data as { providers: string[] };
    assert.deepEqual(recalled.providers, ["memory-obsidian"]);
  } finally {
    await sinty.stop();
    rmSync(vault, { recursive: true, force: true });
    cleanup();
  }
});

test("fact-extractor: afterTurn extracts facts with the cheap route; onWrite drops secrets", async () => {
  const { home, cleanup } = tempHome();
  const script = {
    "my key": [{ toolCalls: [{ name: "memory__write", args: { text: "My api key: sk-abcdefghijklmnopqrstuvwx", tier: "profile", scope: "user", about: "user" } }] }, { text: "I will not store that" }],
    "I moved to Kazan": [{ text: "Noted, Kazan it is." }],
  };
  const summary = { summary: "unused", facts: [{ text: "The user lives in Kazan.", tier: "profile", about: "user" }] };
  const config = cfg(script, ["fact-extractor"], { models: { default: "rec/main", fallback: [], routes: { cheap: "rec/cheap" }, catalog: [], maxOutputTokens: 1000 } }, { summary });
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "my key");
    await sinty.agent.idle();
    sinty.agent.send(s.id, "I moved to Kazan");
    await sinty.agent.idle();
    await sinty.memory.idle();
    const events = sinty.journal.events(s.id);
    const tool = events.find((e) => e.type === "tool.call.completed")?.data as { result: { action: string; by: string } };
    assert.equal(tool.result.action, "dropped");
    assert.equal(tool.result.by, "fact-extractor");
    const cheap = requests(home).filter((r) => r.messages[0]?.content.includes("long-term memory of an assistant"));
    assert.equal(cheap.length, 2, "one extraction per turn");
    const profile = sinty.memory.builtin.store.profile({ agentId: "Sinty", chatId: s.id }).map((f) => f.text);
    assert.deepEqual(profile, ["The user lives in Kazan."]);
    assert.ok(events.some((e) => e.type === "models.called" && (e.data as { plugin: string }).plugin === "fact-extractor"));
    assert.ok(events.some((e) => e.type === "memory.written" && (e.data as { source: string }).source === "fact-extractor"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("$CONFIG.<key> read grants come only from config.yaml and are read-only", async () => {
  const { resolveFsGrants } = await import("../host/manifest.js");
  const { resolvePaths } = await import("../paths.js");
  const { home, cleanup } = tempHome();
  try {
    const paths = resolvePaths(home);
    const manifest = { name: "vaulty", version: "0.0.1", description: "x", kinds: ["memory"], runtime: "node", permissions: { fs: { read: ["$CONFIG.vault"] } }, config: { vault: "/etc" } };
    const loaded = { dir: join(home, "x"), bundled: false, manifest: manifest as never };
    assert.deepEqual(resolveFsGrants(paths, loaded).read, [], "manifest default is ignored");
    assert.deepEqual(resolveFsGrants(paths, loaded, { vault: "relative/path" }).read, [], "relative paths are ignored");
    const vault = mkdtempSync(join(tmpdir(), "sinty-vault-"));
    assert.deepEqual(resolveFsGrants(paths, loaded, { vault }).read, [vault]);
    const writer = { ...loaded, manifest: { ...manifest, permissions: { fs: { write: ["$CONFIG.vault"] } } } as never };
    assert.throws(() => resolveFsGrants(paths, writer, { vault }), /read-only/);
    rmSync(vault, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});
