import type { ContextSnapshot } from "@sinty/sdk";

/** One row of the step list: enough to draw history without sending every prompt. */
export interface SnapshotSummary {
  id: string;
  sessionId: string;
  turnId: string;
  stepId: string;
  step: number;
  at: string;
  route?: string;
  tokens: ContextSnapshot["tokens"];
  messages: number;
  recalled: number;
  hooks: number;
  contexts: number;
  redactions: number;
}

export interface SessionSummary {
  sessionId: string;
  turns: number;
  steps: number;
  lastAt: string;
  lastTokens: number;
}

/**
 * In-memory ring of the newest snapshots, capped by count and by serialized size. Nothing is written to disk:
 * snapshots hold the whole prompt, private memory included, and disappear when the plugin stops.
 */
export class SnapshotStore {
  private readonly items: { snap: ContextSnapshot; bytes: number }[] = [];
  private bytes = 0;

  constructor(
    private readonly keep: number,
    private readonly maxBytes: number,
  ) {}

  add(snap: ContextSnapshot): void {
    const bytes = JSON.stringify(snap).length;
    if (bytes > this.maxBytes) return;
    const i = this.items.findIndex((x) => x.snap.id === snap.id);
    if (i >= 0) {
      this.bytes -= this.items[i]!.bytes;
      this.items.splice(i, 1);
    }
    this.items.push({ snap, bytes });
    this.bytes += bytes;
    while (this.items.length > this.keep || this.bytes > this.maxBytes) this.bytes -= this.items.shift()!.bytes;
  }

  get size(): number {
    return this.items.length;
  }

  get(id: string): ContextSnapshot | undefined {
    return this.items.find((x) => x.snap.id === id)?.snap;
  }

  /** Newest session first. */
  sessions(): SessionSummary[] {
    const by = new Map<string, SessionSummary & { turnIds: Set<string> }>();
    for (const { snap } of this.items) {
      const s = by.get(snap.sessionId) ?? { sessionId: snap.sessionId, turns: 0, steps: 0, lastAt: snap.at, lastTokens: 0, turnIds: new Set<string>() };
      s.turnIds.add(snap.turnId);
      s.turns = s.turnIds.size;
      s.steps++;
      s.lastAt = snap.at;
      s.lastTokens = snap.tokens.total;
      by.set(snap.sessionId, s);
    }
    return [...by.values()].map(({ turnIds: _t, ...s }) => s).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** Steps of one session (or all), oldest first. */
  list(sessionId?: string): SnapshotSummary[] {
    return this.items.filter((x) => !sessionId || x.snap.sessionId === sessionId).map(({ snap }) => summarize(snap));
  }
}

export function summarize(s: ContextSnapshot): SnapshotSummary {
  return {
    id: s.id,
    sessionId: s.sessionId,
    turnId: s.turnId,
    stepId: s.stepId,
    step: s.step,
    at: s.at,
    ...(s.route ? { route: s.route } : {}),
    tokens: s.tokens,
    messages: s.messages.length,
    recalled: s.memory.recall?.records.length ?? 0,
    hooks: s.memory.hooks.length,
    contexts: s.contexts.length,
    redactions: s.redactions,
  };
}
