export type MediaKind = "audio" | "video" | "image";

export interface MediaRef {
  path: string;
  kind: MediaKind;
}

const EXT: Record<string, MediaKind> = {
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
};

const TOKEN = /https?:\/\/[^\s<>"']+\.(?:mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|png|jpe?g|webp|gif)(?:\?[^\s<>"']*)?|_out\/generation\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|png|jpe?g|webp|gif)/gi;

function kindOf(token: string): MediaKind | undefined {
  const clean = token.split("?")[0] ?? token;
  const ext = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
  return EXT[ext];
}

/** Pull playable paths out of an agent message. The raw path is not shown again. */
export function splitMedia(text: string): { text: string; files: MediaRef[] } {
  const files: MediaRef[] = [];
  const seen = new Set<string>();
  const cleaned = text.replace(TOKEN, (token) => {
    const kind = kindOf(token);
    if (!kind || seen.has(token)) return "";
    seen.add(token);
    files.push({ path: token, kind });
    return "";
  });
  return { text: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), files };
}

export function mergeMedia(first: MediaRef[], second: MediaRef[]): MediaRef[] {
  const seen = new Set<string>();
  const out: MediaRef[] = [];
  for (const file of [...first, ...second]) {
    if (!file.path || seen.has(file.path)) continue;
    if (file.kind !== "audio" && file.kind !== "video" && file.kind !== "image") continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}
