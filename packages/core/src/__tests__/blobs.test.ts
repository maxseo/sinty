import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsToMessages } from "../agent.js";
import { materializeAttachmentsToDir, saveBlob } from "../blobs.js";
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
      [{ type: "message.user", data: { text: "РЎРѓР СР С•РЎвЂљРЎР‚Р С‘", attachments: [note, image, doc] } } as SintyEvent],
      dir,
    );
    assert.match(messages[0]!.content, /alpha,beta/);
    assert.match(messages[0]!.content, /Hello PDF/);
    assert.equal(messages[0]!.images?.[0]?.mime, "image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeAttachmentsToDir writes named files and dedupes identical content", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mat-"));
  try {
    const note = saveBlob(dir, { bytes: Buffer.from("same"), mime: "text/plain", name: "a.txt" });
    const inbox = join(dir, "inbox");
    const first = materializeAttachmentsToDir(dir, inbox, [note]);
    assert.equal(first.length, 1);
    assert.equal(readFileSync(join(inbox, "a.txt"), "utf8"), "same");
    const again = materializeAttachmentsToDir(dir, inbox, [note]);
    assert.equal(again[0]?.name, "a.txt");
    assert.equal(readdirSync(inbox).filter((n) => n.startsWith("a")).length, 1);
    const other = saveBlob(dir, { bytes: Buffer.from("other"), mime: "text/plain", name: "a.txt" });
    const second = materializeAttachmentsToDir(dir, inbox, [other]);
    assert.equal(second[0]?.name, "a-2.txt");
    assert.equal(readFileSync(join(inbox, "a-2.txt"), "utf8"), "other");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
