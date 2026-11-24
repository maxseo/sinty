import type { CardType } from "./policy.js";

const KINDS = new Set<CardType>(["person", "preference", "fact", "decision", "question"]);

/** Pulls up to three cards from a model reply. A card without a verbatim quote is ignored. */
export function parseClaims(raw: string): { text: string; kind: CardType; quote: string }[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return [];
    const out: { text: string; kind: CardType; quote: string }[] = [];
    for (const item of parsed.claims) {
      if (!item || typeof item !== "object") continue;
      const text = String((item as { text?: unknown }).text ?? "").replace(/\s+/g, " ").trim();
      const quote = String((item as { quote?: unknown }).quote ?? "").replace(/\s+/g, " ").trim();
      const kind = (item as { kind?: unknown }).kind === "open" ? "question" : (item as { kind?: unknown }).kind;
      if (text.length < 2 || text.length > 500 || quote.length < 2 || !KINDS.has(kind as CardType)) continue;
      out.push({ text, kind: kind as CardType, quote });
      if (out.length === 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

export const EXTRACT_PROMPT = `You keep an assistant's memory cards. Read only what the user said. Keep a card only when the user stated who someone is, a durable fact, a stable preference, a decision, or an open question. Skip greetings, small talk, one-off tasks, and anything the user did not say. Never invent and never include passwords, keys, or tokens.
The quote must be copied verbatim from the user's words. The text is one short sentence in the user's language.
Reply with JSON only: {"claims":[{"text":"...","quote":"...","kind":"person|preference|fact|decision|question"}]}
Use person for a name, preference for a habit, fact for a standing fact, decision for a choice, question for something still open.
If nothing is worth keeping, reply {"claims":[]}. At most 3 claims.`;
