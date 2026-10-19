import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsToMessages } from "../agent.js";
import { saveBlob } from "../blobs.js";
import type { SintyEvent } from "@sinty/sdk";

test("a text attachment is inlined and an image is passed beside the text", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-blob-"));
  try {
    const note = saveBlob(dir, { bytes: Buffer.from("alpha,beta\n1,2"), mime: "text/csv", name: "t.csv" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const image = saveBlob(dir, { bytes: png, mime: "image/png", name: "dot.png" });
    const pdf = Buffer.from("%PDF-1.1\n1 0 obj<</Length 44>>stream\nBT (Hello PDF) Tj ET\nendstream\nendobj\ntrailer<>\n%%EOF");
    const doc = saveBlob(dir, { bytes: pdf, mime: "application/pdf", name: "a.pdf" });
    const messages = eventsToMessages(
      [{ type: "message.user", data: { text: "смотри", attachments: [note, image, doc] } } as SintyEvent],
      dir,
    );
    assert.match(messages[0]!.content, /alpha,beta/);
    assert.match(messages[0]!.content, /Hello PDF/);
    assert.equal(messages[0]!.images?.[0]?.mime, "image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
