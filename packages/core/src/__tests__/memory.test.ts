import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore, parseSummaryPayload, trimOldToolResults } from "../memory.js";

function open(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mem-"));
  return new MemoryStore(join(dir, "memory.db"), { userId: "local", agentId: "Sinty", dimensions: 4 });
}

test("memory: dedup, profile cap, recall skips profile, vector hit", () => {
  const store = open();
  assert.equal(store.vec, true);
  const first = store.write({ text: "Max prefers short answers.", tier: "profile", scope: "user", about: "user", source: "chat" });
  const again = store.write({ text: "  max   prefers short answers. ", tier: "profile", scope: "user", about: "user", source: "chat" });
  assert.equal(again.id, first.id);
  assert.equal(again.action, "updated");
  store.write({ text: "The site deploy goes through n8nflow.", tier: "log", scope: "agent", about: "work", source: "chat" });
  store.write({
    text: "Ticket 441 is the voice webhook.",
    tier: "note",
    scope: "chat",
    about: "work",
    source: "chat",
    chatId: "ses_1",
    embedding: new Float32Array([1, 0, 0, 0]),
  });
  const found = store.recall({ query: "441", chatId: "ses_1" });
  assert.equal(found.length, 1);
  assert.match(found[0]!.text, /441/);
  const byVec = store.recall({ query: "zzzz-no-such-word", chatId: "ses_1", embedding: new Float32Array([1, 0, 0, 0]) });
  assert.equal(byVec[0]?.text.includes("441"), true);
  const profile = store.recall({ query: "short answers", chatId: "ses_1" });
  assert.equal(profile.length, 0);
  for (let i = 0; i < 39; i++) store.write({ text: `Profile fact number ${i} is unique.`, tier: "profile", scope: "user", about: "user", source: "test" });
  assert.throws(() => store.write({ text: "One fact too many for the profile.", tier: "profile", scope: "user", about: "user", source: "test" }));
  store.close();
});

test("memory: newer user fact replaces the same sentence, work fact stays on the agent", () => {
  const store = open();
  store.write({ text: "Use the workspace folder for drafts.", tier: "log", scope: "agent", about: "work", source: "agent" });
  const kept = store.write({ text: "Use the workspace folder for drafts.", tier: "log", scope: "user", about: "work", source: "user" });
  assert.equal(kept.action, "updated");
  assert.equal(store.recall({ query: "workspace", chatId: "s" })[0]?.scope, "agent");
  store.write({ text: "The user lives in Moscow.", tier: "profile", scope: "agent", about: "user", source: "old" });
  store.write({ text: "The user lives in Moscow.", tier: "profile", scope: "user", about: "user", source: "new" });
  assert.equal(store.profile().length, 1);
  assert.equal(store.profile()[0]?.scope, "user");
  store.close();
});

test("summary payload and old tool trim", () => {
  const parsed = parseSummaryPayload('noise {"summary":"Did the deploy.","facts":[{"text":"Deploy is manual.","tier":"log","about":"work"}]}');
  assert.equal(parsed?.summary, "Did the deploy.");
  assert.equal(parsed?.facts[0]?.about, "work");
  const messages = [];
  for (let i = 0; i < 14; i++) {
    messages.push({ role: "user" as const, content: `q${i}` });
    messages.push({ role: "tool" as const, toolCallId: String(i), content: Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n") });
  }
  const trimmed = trimOldToolResults(messages, 12);
  assert.match(trimmed[1]!.content, /truncated/);
  assert.doesNotMatch(trimmed.at(-1)!.content, /truncated/);
});

test("memory: profile and recent journal only show facts this persona and chat may see", () => {
  const store = open();
  store.write({ text: "The user is Max.", tier: "profile", scope: "user", about: "user", source: "t" });
  store.write({ text: "Writer persona uses a formal tone.", tier: "profile", scope: "agent", about: "work", source: "t", agentId: "writer" });
  store.write({ text: "Coder persona deployed build 7.", tier: "log", scope: "agent", about: "work", source: "t", agentId: "coder" });
  store.write({ text: "This chat is about invoices.", tier: "log", scope: "chat", about: "work", source: "t", agentId: "coder", chatId: "ses_a" });
  const writer = { agentId: "writer", chatId: "ses_b" };
  assert.deepEqual(store.profile(writer).map((f) => f.text), ["The user is Max.", "Writer persona uses a formal tone."]);
  assert.deepEqual(store.recentLog(10, writer).map((f) => f.text), []);
  const coderA = { agentId: "coder", chatId: "ses_a" };
  assert.deepEqual(store.profile(coderA).map((f) => f.text), ["The user is Max."]);
  assert.deepEqual(store.recentLog(10, coderA).map((f) => f.text).sort(), ["Coder persona deployed build 7.", "This chat is about invoices."]);
  assert.deepEqual(store.recentLog(10, { agentId: "coder", chatId: "ses_other" }).map((f) => f.text), ["Coder persona deployed build 7."]);
  assert.equal(store.recall({ query: "build", chatId: "x", agentId: "writer" }).length, 0);
  assert.equal(store.recall({ query: "build", chatId: "x", agentId: "coder" }).length, 1);
  store.close();
});
