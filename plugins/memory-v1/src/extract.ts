import type { CardType } from "./policy.js";

const KINDS = new Set<CardType>(["person", "preference", "fact", "decision", "question", "observation", "file", "architecture", "outcome"]);

export interface ParsedClaim {
  text: string;
  kind: CardType;
  quote: string;
  subject: string;
  path: string;
}

/** Pulls up to three cards from a model reply. A card without a verbatim quote is ignored. */
export function parseClaims(raw: string): ParsedClaim[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return [];
    const out: ParsedClaim[] = [];
    for (const item of parsed.claims) {
      if (!item || typeof item !== "object") continue;
      const row = item as { text?: unknown; quote?: unknown; kind?: unknown; subject?: unknown; path?: unknown };
      const text = String(row.text ?? "").replace(/\s+/g, " ").trim();
      const quote = String(row.quote ?? "").replace(/\s+/g, " ").trim();
      const kind = row.kind === "open" ? "question" : row.kind;
      const subject = String(row.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const path = String(row.path ?? "").trim().slice(0, 300);
      if (text.length < 2 || text.length > 500 || quote.length < 2 || !KINDS.has(kind as CardType)) continue;
      out.push({ text, kind: kind as CardType, quote, subject, path });
      if (out.length === 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

export const EXTRACT_PROMPT = `You keep an assistant's memory cards. Read only what the user said. Keep a card only when the user stated who someone is, a durable fact, a stable preference, a decision, an open question, a file path, how the project is built, or whether an attempt worked or failed. Skip greetings, small talk, and anything the user did not say. Never invent and never include passwords, keys, or tokens.
The quote must be copied verbatim from the user's words. The text is one short sentence in the user's language. subject is a short stable key such as "город" or "doc-check", empty if there is none. path is a file path copied from the user's words, empty if there is none.
Reply with JSON only: {"claims":[{"text":"...","quote":"...","subject":"...","path":"...","kind":"person|preference|fact|decision|question|observation|file|architecture|outcome"}]}
Use person for a name, preference for a habit, fact for a standing fact, decision for a choice, question for something still open, observation for something that happened, file for a path, architecture for how the project is put together, outcome for what worked or failed.
If nothing is worth keeping, reply {"claims":[]}. At most 3 claims.`;

const NIGHT_RELS = new Set(["supports", "contradicts", "continues"]);

/** Subjects and links the night pass may apply. Unknown ids are dropped. Nothing new is invented here. */
export function parseNightLinks(raw: string, ids: Set<string>): { subjects: { id: string; subject: string }[]; links: { from: string; to: string; rel: "supports" | "contradicts" | "continues" }[] } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { subjects: [], links: [] };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { subjects?: unknown; links?: unknown };
    const subjects: { id: string; subject: string }[] = [];
    if (Array.isArray(parsed.subjects)) {
      for (const item of parsed.subjects) {
        if (!item || typeof item !== "object") continue;
        const row = item as { id?: unknown; subject?: unknown };
        const id = String(row.id ?? "");
        const subject = String(row.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!ids.has(id) || subject.length < 2) continue;
        subjects.push({ id, subject });
      }
    }
    const links: { from: string; to: string; rel: "supports" | "contradicts" | "continues" }[] = [];
    if (Array.isArray(parsed.links)) {
      for (const item of parsed.links) {
        if (!item || typeof item !== "object") continue;
        const row = item as { from?: unknown; to?: unknown; rel?: unknown };
        const from = String(row.from ?? "");
        const to = String(row.to ?? "");
        const rel = String(row.rel ?? "");
        if (!ids.has(from) || !ids.has(to) || from === to || !NIGHT_RELS.has(rel)) continue;
        links.push({ from, to, rel: rel as "supports" | "contradicts" | "continues" });
      }
    }
    return { subjects, links };
  } catch {
    return { subjects: [], links: [] };
  }
}
