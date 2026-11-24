import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "@sinty/sdk";
import { estimateTokens, IMAGE_TOKEN_RESERVE } from "../memory.js";
import { boot, tempHome } from "./helpers.js";

test("multimodal accounting: text-only estimate including tool overhead is unchanged", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Привет" }, { role: "tool", content: "result", toolCallId: "c" }];
  for (const extra of [0, 1, 17, 1000]) assert.equal(estimateTokens(messages, extra), Math.ceil((JSON.stringify(messages).length + extra) / 4));
});
test("multimodal accounting: base64 transfer size is never text tokens; pixels are preserved", () => {
  const small: ChatMessage[] = [{ role: "user", content: "observe", images: [{ mime: "image/png", data: "A".repeat(4) }] }];
  const large: ChatMessage[] = [{ ...small[0]!, images: [{ mime: "image/png", data: "A".repeat(5_000_000) }] }];
  const before = JSON.stringify(large); assert.equal(estimateTokens(small), estimateTokens(large));
  assert.ok(estimateTokens(large) >= IMAGE_TOKEN_RESERVE); assert.ok(estimateTokens(large) < IMAGE_TOKEN_RESERVE + 100);
  assert.equal(JSON.stringify(large), before);
  const delta = estimateTokens([{ ...large[0]!, images: [...large[0]!.images!, ...large[0]!.images!] }]) - estimateTokens(large);
  assert.ok(delta >= IMAGE_TOKEN_RESERVE && delta <= IMAGE_TOKEN_RESERVE + 16);
});
test("multimodal fallback: preserve image bytes when fitting; explicitly reject a smaller window", async () => {
  const { home, cleanup } = tempHome(); const sinty = await boot(home, [], { config: { models: { default: "fake/wide", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000, contextWindows: { "fake/tiny": 1000, "fake/wide": 100000 } } } });
  try {
    const messages: ChatMessage[] = [{ role: "user", content: "observe", images: [{ mime: "image/png", data: "A".repeat(1_000_000) }] }];
    const fit = (sinty.agent as unknown as { fitWindow(s: string, route: string, m: ChatMessage[], t: never[], n: number): { ok: boolean; messages?: ChatMessage[] } }).fitWindow.bind(sinty.agent);
    const id = sinty.agent.createSession().id;
    const good = fit(id, "fake/wide", messages, [], estimateTokens(messages)); assert.equal(good.ok, true); assert.equal(good.messages?.[0]?.images?.[0]?.data.length, 1_000_000);
    assert.equal(fit(id, "fake/tiny", messages, [], estimateTokens(messages)).ok, false);
  } finally { await sinty.stop(); cleanup(); }
});
