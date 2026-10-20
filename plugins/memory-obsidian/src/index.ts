import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { definePlugin, type MemoryRecord } from "@sinty/sdk";

interface Chunk {
  heading: string;
  text: string;
  terms: Record<string, number>;
  length: number;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  title: string;
  chunks: Chunk[];
}

interface Index {
  version: 1;
  vault: string;
  files: Record<string, FileEntry>;
}

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length > 1 && t.length < 40);
}

/** Splits a note by headings; frontmatter is dropped, wiki links keep their label. */
export function chunkNote(raw: string, title: string): Chunk[] {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, target: string, label: string) => label || target);
  const parts: { heading: string; lines: string[] }[] = [{ heading: title, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) parts.push({ heading: h[1]!.trim(), lines: [] });
    else parts.at(-1)!.lines.push(line);
  }
  return parts
    .map((p) => ({ heading: p.heading, text: p.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((p) => p.text.length > 0)
    .map((p) => {
      const terms: Record<string, number> = {};
      const tokens = tokenize(`${title} ${p.heading} ${p.text}`);
      for (const t of tokens) terms[t] = (terms[t] ?? 0) + 1;
      for (const t of tokenize(`${title} ${p.heading}`)) terms[t] = (terms[t] ?? 0) + 2;
      return { heading: p.heading, text: p.text.slice(0, 4000), terms, length: tokens.length };
    });
}

/** BM25 over chunks. */
export function search(index: Index, query: string, limit: number): { path: string; chunk: Chunk; score: number; file: FileEntry }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const all: { path: string; chunk: Chunk; file: FileEntry }[] = [];
  for (const [path, file] of Object.entries(index.files)) for (const chunk of file.chunks) all.push({ path, chunk, file });
  if (!all.length) return [];
  const avg = all.reduce((n, c) => n + c.chunk.length, 0) / all.length || 1;
  const df = new Map(q.map((t) => [t, all.filter((c) => c.chunk.terms[t]).length]));
  const k1 = 1.2;
  const b = 0.75;
  return all
    .map((c) => {
      let score = 0;
      for (const t of q) {
        const tf = c.chunk.terms[t] ?? 0;
        if (!tf) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (all.length - n + 0.5) / (n + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.chunk.length) / avg));
      }
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, limit);
}

export default definePlugin({
  name: "memory-obsidian",
  setup(ctx) {
    const vault = typeof ctx.config.vault === "string" ? ctx.config.vault : "";
    const maxFiles = Number(ctx.config.maxFiles ?? 5000);
    const maxBytes = Number(ctx.config.maxFileBytes ?? 524_288);
    const rescanMs = Number(ctx.config.rescanSeconds ?? 60) * 1000;
    const indexFile = join(ctx.paths.data, "index.json");
    let index: Index = { version: 1, vault, files: {} };
    let scannedAt = 0;

    if (existsSync(indexFile)) {
      try {
        const saved = JSON.parse(readFileSync(indexFile, "utf8")) as Index;
        if (saved.version === 1 && saved.vault === vault) index = saved;
      } catch {
        /* a broken index is rebuilt */
      }
    }

    const scan = (): void => {
      if (!vault || !existsSync(vault)) return;
      const seen = new Set<string>();
      let changed = false;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (seen.size >= maxFiles) return;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            const rel = relative(vault, full).split(sep).join("/");
            const st = statSync(full);
            if (st.size > maxBytes) continue;
            seen.add(rel);
            const old = index.files[rel];
            if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
            const title = entry.name.replace(/\.md$/i, "");
            index.files[rel] = { mtimeMs: st.mtimeMs, size: st.size, title, chunks: chunkNote(readFileSync(full, "utf8"), title) };
            changed = true;
          }
        }
      };
      walk(vault);
      for (const rel of Object.keys(index.files)) {
        if (!seen.has(rel)) {
          delete index.files[rel];
          changed = true;
        }
      }
      if (changed) writeFileSync(indexFile, JSON.stringify(index));
      scannedAt = Date.now();
    };

    if (!vault) ctx.log.warn('no vault configured: set plugins.config.memory-obsidian.vault in config.yaml to an absolute path');
    else {
      try {
        scan();
        ctx.log.info(`indexed ${Object.keys(index.files).length} notes`);
      } catch (e) {
        ctx.log.error(`vault scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    ctx.memory.provider({
      name: "memory-obsidian",
      async recall({ query, limit }) {
        if (!vault) return [];
        if (Date.now() - scannedAt > rescanMs) scan();
        return search(index, query, Math.min(limit ?? 5, 10)).map(
          (hit, i): MemoryRecord => ({
            id: `${hit.path}#${hit.file.chunks.indexOf(hit.chunk)}`,
            provider: "memory-obsidian",
            ref: hit.path,
            text: `${hit.file.title}${hit.chunk.heading !== hit.file.title ? ` › ${hit.chunk.heading}` : ""}: ${hit.chunk.text.replace(/\s+/g, " ").slice(0, 600)}`,
            createdAt: new Date(hit.file.mtimeMs).toISOString(),
            score: Math.round(hit.score * 1000) / 1000 - i * 1e-6,
          }),
        );
      },
    });
  },
});
