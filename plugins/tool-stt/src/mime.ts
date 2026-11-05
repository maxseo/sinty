const BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpga": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".webm": "video/webm",
  ".flac": "audio/flac",
};

export function mimeFromExt(path: string): string | undefined {
  const i = path.lastIndexOf(".");
  if (i < 0) return undefined;
  return BY_EXT[path.slice(i).toLowerCase()];
}

/** Sniff containers the transcription endpoint accepts. */
export function mimeFromMagic(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return "audio/wav";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return undefined;
}

export function resolveMime(path: string, bytes: Uint8Array): string | undefined {
  return mimeFromExt(path) ?? mimeFromMagic(bytes);
}

export function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/") || mime === "video/mp4" || mime === "video/mpeg" || mime === "video/webm";
}
