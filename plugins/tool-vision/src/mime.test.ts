import assert from "node:assert/strict";
import { test } from "node:test";
import { isImageMime, mimeFromExt, mimeFromMagic, resolveMime } from "./mime.ts";

test("mimeFromExt", () => {
  assert.equal(mimeFromExt("a.PNG"), "image/png");
  assert.equal(mimeFromExt("x.jpeg"), "image/jpeg");
  assert.equal(mimeFromExt("noext"), undefined);
});

test("mimeFromMagic png/jpeg", () => {
  assert.equal(mimeFromMagic(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(mimeFromMagic(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(mimeFromMagic(Uint8Array.of(0x00, 0x01)), undefined);
});

test("resolveMime and isImageMime", () => {
  assert.equal(resolveMime("a.bin", Uint8Array.of(0xff, 0xd8, 0xff)), "image/jpeg");
  assert.equal(isImageMime("image/png"), true);
  assert.equal(isImageMime("image/svg+xml"), false);
  assert.equal(isImageMime("application/pdf"), false);
});
