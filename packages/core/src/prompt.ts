import type { CacheHint, ChatMessage } from "@sinty/sdk";

/**
 * Cache-friendly prompt layout helpers (docs/spec/protocol.md, "Prompt caching").
 *
 * The prompt is built in stability zones, most stable first: tools → system (persona, rules, project, skills) →
 * session memory snapshot and summary → dialogue. Everything that changes per turn (time, recall, memory updates) is
 * written once into a turn context message that stays in the dialogue unchanged, so every call only appends.
 */

export const TURN_CONTEXT_OPEN = "<turn_context>";
const TURN_CONTEXT_CLOSE = "</turn_context>";

export function isTurnContext(m: ChatMessage): boolean {
  return m.role === "user" && m.content.startsWith(TURN_CONTEXT_OPEN);
}

/** A human message: not a supervisor notice and not a turn context. */
export function isHumanMessage(m: ChatMessage): boolean {
  return m.role === "user" && !m.content.startsWith("[supervisor]") && !m.content.startsWith(TURN_CONTEXT_OPEN);
}

/** A valid IANA zone: the configured one, else the process zone, else UTC. */
export function resolveTimezone(configured: string | undefined): string {
  for (const tz of [configured, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    if (!tz) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      /* unknown zone: try the next one */
    }
  }
  return "UTC";
}

/** "2026-10-20 16:09, Tuesday (Europe/Moscow, UTC+03:00)": minutes only, so steps of a turn agree byte for byte. */
export function formatTurnTime(at: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long", timeZoneName: "longOffset" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const offset = (parts.timeZoneName ?? "GMT").replace(/^GMT$/, "GMT+00:00").replace(/^GMT/, "UTC");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}, ${parts.weekday} (${timezone}, ${offset})`;
}

/** The text of a turn context message. Blocks keep their own tags (recalled_memory, memory_updates…). */
export function renderTurnContext(at: Date, timezone: string, blocks: { content: string }[]): string {
  return [
    TURN_CONTEXT_OPEN,
    "Context the core adds at the start of this turn. It is not written by the user.",
    `Current time: ${formatTurnTime(at, timezone)}.`,
    ...blocks.map((b) => b.content),
    TURN_CONTEXT_CLOSE,
  ].join("\n");
}

/** Copy without core-only fields, for byte comparisons and hashes. */
export function withoutHint(m: ChatMessage): ChatMessage {
  if (!m.cacheHint) return m;
  const { cacheHint: _h, ...rest } = m;
  return rest;
}

export function hint(m: ChatMessage, cacheHint: CacheHint): ChatMessage {
  return { ...m, cacheHint };
}
