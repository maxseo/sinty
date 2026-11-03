import assert from "node:assert/strict";
import { test } from "node:test";
import { isAudioMime, mimeFromMagic, resolveMime } from "./mime.ts";

test("mime: extension wins, magic covers a nameless wav", () => {
  assert.equal(resolveMime("voice.mp3", new Uint8Array()), "audio/mpeg");
  assert.equal(resolveMime("clip.MP4", new Uint8Array()), "video/mp4");
  const wav = new Uint8Array(12);
  wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(mimeFromMagic(wav), "audio/wav");
  assert.equal(resolveMime("noext", wav), "audio/wav");
  assert.equal(isAudioMime("audio/mpeg"), true);
  assert.equal(isAudioMime("video/mp4"), true);
  assert.equal(isAudioMime("image/png"), false);
});
