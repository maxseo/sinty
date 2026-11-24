import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ProviderRequest } from "@sinty/sdk";
import { buildBody } from "./index.js";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwN8AAAAASUVORK5CYII=";
test("provider-openai-responses: replayed tool observations become real vision blocks without changing the tool batch", () => {
  const messages: ChatMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "capture", args: {} }] },
    { role: "tool", toolCallId: "c", content: '{"blob":"sha256:fixture"}', untrusted: true },
    { role: "user", content: "Untrusted tool image observation", untrusted: true, images: [{ mime: "image/png", data: PNG }] },
  ];
  const request: ProviderRequest = { endpoint: { baseUrl: "https://invalid.example" }, model: "synthetic", messages, tools: [], signal: new AbortController().signal };
  const body = buildBody(request) as { input: { content: unknown[] }[] };
  assert.deepEqual(body.input.at(-1)!.content.at(-1), { type: "input_image", image_url: "data:image/png;base64," + PNG });
  assert.ok(JSON.stringify(body).includes("sha256:fixture"));
  assert.ok(!JSON.stringify(messages[1]).includes(PNG), "tool text contains the reference, not inline image bytes");
});
