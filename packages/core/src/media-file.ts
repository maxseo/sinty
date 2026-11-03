import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { isInside } from "./paths.js";

export type MediaKind = "audio" | "video" | "image";

export interface MediaRef {
  path: string;
  kind: MediaKind;
}

const KIND: Record<string, MediaKind> = {
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
};

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mediaKind(file: string): MediaKind | undefined {
  return KIND[extname(file.split("?")[0] ?? file).toLowerCase()];
}

/** A project-relative `_out/generation` media path, or nothing. */
export function generationPath(workspace: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  let rel = trimmed.replace(/\\/g, "/");
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    rel = relative(workspace, trimmed).replace(/\\/g, "/");
  }
  if (!rel.startsWith("_out/generation/")) return undefined;
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return undefined;
  if (!mediaKind(rel)) return undefined;
  return rel;
}

/** Media files a tool result saved under the session project. */
export function generationMedia(workspace: string, result: unknown): MediaRef[] {
  const found: MediaRef[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") {
      const path = generationPath(workspace, value);
      const kind = path ? mediaKind(path) : undefined;
      if (!path || !kind || seen.has(path)) return;
      seen.add(path);
      found.push({ path, kind });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(result, 0);
  return found;
}

/** The file on disk for a chat media request, inside the session project only. */
export function openGenerationFile(workspace: string, raw: string): { file: string; type: string } | undefined {
  const rel = generationPath(workspace, raw);
  if (!rel) return undefined;
  const file = resolve(workspace, rel);
  if (!isInside(file, workspace) || !existsSync(file) || !statSync(file).isFile()) return undefined;
  const type = MIME[extname(rel).toLowerCase()];
  if (!type) return undefined;
  return { file, type };
}
