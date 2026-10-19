import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { isInside } from "../paths.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** The UI holds the API token, so it may load scripts only from this origin and never be framed. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Serves a file from `root`; paths without an extension fall back to `index.html` for client-side routing. */
export function serveStatic(root: string, rel: string): Response {
  const clean = normalize(decodeURIComponent(rel || "index.html")).replace(/^([/\\])+/, "");
  let file = join(root, clean);
  if (!isInside(file, root)) return new Response("not found", { status: 404 });
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(clean)) return new Response("not found", { status: 404 });
    file = join(root, "index.html");
    if (!existsSync(file)) return new Response("UI is not built: run pnpm build", { status: 404 });
  }
  const ext = extname(file).toLowerCase();
  const immutable = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/.test(file);
  return new Response(readFileSync(file), {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(ext === ".html" ? { "content-security-policy": UI_CSP } : {}),
    },
  });
}

/** `:name` matches one segment; a trailing `*` matches the rest (as `params["*"]`). */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg === "*" && i === p.length - 1) {
      params["*"] = s.slice(i).join("/");
      return params;
    }
    const value = s[i];
    if (value === undefined) return null;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(value);
    else if (seg !== value) return null;
  }
  return s.length === p.length ? params : null;
}
