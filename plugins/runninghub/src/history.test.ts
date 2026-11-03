import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moneyOf, openHistory } from "./history.js";

test("a generation is stored with its task, duration and cost", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hist-"));
  const history = openHistory(join(dir, "generations.db"));
  history.add({
    taskId: "2117",
    endpoint: "bytedance/doubao-seed-tts-2.0",
    name: "doubao-seed-tts-2.0",
    status: "success",
    startedAt: "2026-11-03T11:00:00.000Z",
    finishedAt: "2026-11-03T11:00:40.000Z",
    durationMs: 40_000,
    error: "",
    payload: "{\"text\":\"привет\"}",
    outputs: "[{\"url\":\"https://cdn.example/a.mp3\"}]",
    coins: "1",
    amount: "0.044",
    detail: "{}",
  });
  const rows = history.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.taskId, "2117");
  assert.equal(rows[0]?.durationMs, 40_000);
  assert.equal(rows[0]?.amount, "0.044");
  history.close();
});

test("coins and dollars are read from the task response", () => {
  assert.deepEqual(moneyOf({ data: { consumeCoins: 2, consumeMoney: 0.06 } }), { coins: "2", amount: "0.06" });
  assert.deepEqual(moneyOf({ status: "SUCCESS" }), { coins: "", amount: "" });
});
