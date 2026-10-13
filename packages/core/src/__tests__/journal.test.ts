import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../journal.js";
import { tempHome } from "./helpers.js";

const actor = { kind: "system", id: "test" } as const;

test("journal assigns increasing seq per session and survives reopen", () => {
  const { home, cleanup } = tempHome();
  try {
    const file = join(home, "j.db");
    let j = new Journal(file);
    j.createSession("ses_a", {});
    j.createSession("ses_b", {});
    const a1 = j.append({ sessionId: "ses_a", type: "message.user", actor, data: { text: "1" } });
    const b1 = j.append({ sessionId: "ses_b", type: "message.user", actor, data: { text: "x" } });
    const a2 = j.append({ sessionId: "ses_a", type: "message.user", actor, data: { text: "2" } });
    assert.deepEqual([a1.seq, b1.seq, a2.seq], [1, 1, 2]);
    j.close();

    j = new Journal(file);
    assert.deepEqual(
      j.events("ses_a").map((e) => (e.data as { text: string }).text),
      ["1", "2"],
    );
    assert.equal(j.events("ses_a", { afterSeq: 1 }).length, 1);
    j.close();
  } finally {
    cleanup();
  }
});

test("journal redacts secrets and rejects stream-only events", () => {
  const { home, cleanup } = tempHome();
  try {
    const j = new Journal(join(home, "j.db"), (t) => t.replaceAll("sk-very-secret", "[redacted]"));
    j.createSession("ses_a", {});
    const e = j.append({ sessionId: "ses_a", type: "message.user", actor, data: { text: "key is sk-very-secret" } });
    assert.equal((e.data as { text: string }).text, "key is [redacted]");
    assert.throws(() => j.append({ sessionId: "ses_a", type: "model.delta", actor, data: { text: "x" } }), /stream-only/);
    j.close();
  } finally {
    cleanup();
  }
});

test("idempotency keys map to the first turn", () => {
  const { home, cleanup } = tempHome();
  try {
    const j = new Journal(join(home, "j.db"));
    j.createSession("ses_a", {});
    j.rememberIdempotency("k1", "ses_a", "trn_1");
    j.rememberIdempotency("k1", "ses_a", "trn_2");
    assert.equal(j.idempotentTurn("k1")?.turnId, "trn_1");
    j.close();
  } finally {
    cleanup();
  }
});
