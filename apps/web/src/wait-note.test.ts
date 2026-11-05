import assert from "node:assert/strict";
import test from "node:test";
import { waitNote } from "./wait-note.ts";

const base = { sessionId: "ses", turnId: "trn", approvals: [] as PendingApprovals };

type PendingApprovals = { callId: string; tool: string; args: unknown; reason: string }[];

test("a supervisor wait tells the user to write a message", () => {
  const text = waitNote({ ...base, reason: "supervisor", detail: "три ошибки подряд" });
  assert.equal(text, "Супервизор остановил ход. Напишите сообщение, чтобы продолжить.");
});

test("a question is the question itself", () => {
  assert.equal(waitNote({ ...base, reason: "ask_human", detail: "Какой адрес?" }), "Какой адрес?");
});

test("an approval names the tool", () => {
  const text = waitNote({
    ...base,
    reason: "approval",
    approvals: [{ callId: "c", tool: "runninghub.run", args: {}, reason: "external" }],
  });
  assert.equal(text, "Нужно одобрить: runninghub.run.");
});
