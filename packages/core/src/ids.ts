import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: Uint8Array = new Uint8Array(10);

/** Monotonic ULID: sortable by time, unique within the process. */
export function ulid(now = Date.now()): string {
  let random: Uint8Array;
  if (now === lastTime) {
    random = increment(lastRandom);
  } else {
    random = randomBytes(10);
    lastTime = now;
  }
  lastRandom = random;
  return encodeTime(now) + encodeRandom(random);
}

export function newId(prefix: "ses" | "trn" | "stp" | "call" | "pat" | "inc" | "tsk"): string {
  return `${prefix}_${ulid()}`;
}

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function increment(bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === 255) {
      next[i] = 0;
    } else {
      next[i] = next[i]! + 1;
      break;
    }
  }
  return next;
}
