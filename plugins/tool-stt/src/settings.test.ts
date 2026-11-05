import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("readSettings: defaults and a two-letter language", () => {
  const s = readSettings({});
  assert.equal(s.modelRoute, "");
  assert.equal(s.maxBytes, 25_000_000);
  assert.equal(s.language, "");
  assert.equal(readSettings({ language: "RU", maxAudioMb: 8, modelRoute: " openai/whisper-1 " }).language, "ru");
  assert.equal(readSettings({ language: "russian" }).language, "");
  assert.equal(readSettings({ maxAudioMb: 100 }).maxBytes, 25_000_000);
});
