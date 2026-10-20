import { definePlugin, type MemoryAbout, type MemoryTier, type MemoryWrite } from "@sinty/sdk";

const SECRET_PATTERNS = [
  /\b(sk|pk|rk|xai|ghp|gho|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{12,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|пароль|api[_ -]?key|token|secret)\b\s*[:=]\s*\S+/i,
  /\b[A-Fa-f0-9]{40,}\b/,
  /\b[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/])/,
];

/** Facts that must never be stored: credentials, keys, long opaque tokens. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(text));
}

export function parseFacts(raw: string, max: number): { text: string; tier: MemoryTier; about: MemoryAbout }[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter((f): f is { text: string; tier?: string; about?: string } => Boolean(f) && typeof (f as { text?: unknown }).text === "string")
      .map((f) => ({ text: f.text.trim(), tier: (f.tier === "profile" || f.tier === "note" ? f.tier : "log") as MemoryTier, about: (f.about === "work" ? "work" : "user") as MemoryAbout }))
      .filter((f) => f.text.length > 0)
      .slice(0, max);
  } catch {
    return [];
  }
}

const PROMPT = `You maintain the long-term memory of an assistant. From the conversation turn below, extract at most {MAX} durable facts worth remembering for future conversations: stable preferences, decisions, names, deadlines, project facts. Skip small talk, one-off requests, anything already obvious, and never include passwords, keys or tokens.
Each fact is one short self-contained sentence in the language of the conversation. tier: "profile" for stable facts about the user, "log" for events and decisions, "note" for short-lived details. about: "user" or "work".
If there is nothing worth remembering, return an empty list.
Reply with JSON only: {"facts":[{"text":"...","tier":"profile|log|note","about":"user|work"}]}`;

export default definePlugin({
  name: "fact-extractor",
  setup(ctx) {
    const maxFacts = Number(ctx.config.maxFacts ?? 3);
    const minChars = Number(ctx.config.minChars ?? 12);
    const maxChars = Number(ctx.config.maxChars ?? 300);

    ctx.memory.processor({
      name: "fact-extractor",
      order: 50,
      async afterTurn({ turn, messages }) {
        const transcript = messages
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n")
          .slice(-12_000);
        if (!transcript.trim()) return {};
        const r = await ctx.models.complete({
          route: "cheap",
          maxOutputTokens: 600,
          sessionId: turn.sessionId,
          messages: [{ role: "user", content: `${PROMPT.replace("{MAX}", String(maxFacts))}\n\nConversation turn:\n${transcript}` }],
        });
        return { facts: parseFacts(r.text, maxFacts) };
      },
      /** Drops secrets and fragments, trims whitespace; applies to every memory write, not only extracted facts. */
      async onWrite(w: MemoryWrite) {
        const text = w.text.replace(/\s+/g, " ").trim();
        if (looksSecret(text)) {
          ctx.log.warn("dropped a memory write that looks like a secret");
          return null;
        }
        if (text.length < minChars && w.source !== "agent") return null;
        return { ...w, text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text };
      },
    });
  },
});
