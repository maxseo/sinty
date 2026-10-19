import type { EventDataMap, LiveEvent, SintyEvent } from "./events.js";
import type { AgentApi } from "./plugin.js";

export interface TurnOutcome {
  turnId: string;
  status: "completed" | "blocked" | "failed" | "interrupted";
  /** The final answer, or the last text the model produced before the turn stopped. */
  text: string;
  blocked?: EventDataMap["turn.blocked"];
  error?: { code: string; message: string };
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Sends a message and follows the turn until it completes, blocks or fails.
 * A blocked turn (approval, question, supervisor) returns; continue it with another `send`.
 */
export async function runTurn(
  agent: AgentApi,
  sessionId: string,
  text: string,
  opts: { signal?: AbortSignal; idempotencyKey?: string; channel?: string; onEvent?: (e: LiveEvent) => void } = {},
): Promise<TurnOutcome> {
  const session = await agent.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const { turnId } = await agent.send(sessionId, text, { ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}), ...(opts.channel ? { channel: opts.channel } : {}) });
  const out: TurnOutcome = { turnId, status: "interrupted", text: "", usage: { inputTokens: 0, outputTokens: 0 } };
  let lastModelText = "";
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const e of agent.stream(sessionId, { afterSeq: session.lastSeq, signal: ac.signal })) {
      if (e.turnId !== turnId) continue;
      opts.onEvent?.(e);
      switch (e.type) {
        case "model.response":
          lastModelText = (e as SintyEvent<"model.response">).data.text ?? "";
          break;
        case "usage.recorded": {
          const u = (e as SintyEvent<"usage.recorded">).data;
          out.usage.inputTokens += u.inputTokens;
          out.usage.outputTokens += u.outputTokens;
          break;
        }
        case "message.agent":
          out.text = (e as SintyEvent<"message.agent">).data.text;
          break;
        case "turn.completed":
          out.status = "completed";
          return out;
        case "turn.blocked":
          out.status = "blocked";
          out.blocked = (e as SintyEvent<"turn.blocked">).data;
          out.text ||= lastModelText;
          return out;
        case "turn.failed":
          out.status = "failed";
          out.error = (e as SintyEvent<"turn.failed">).data;
          out.text ||= lastModelText;
          return out;
        case "turn.interrupted":
          out.status = "interrupted";
          out.text ||= lastModelText;
          return out;
      }
    }
    return out;
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    ac.abort();
  }
}

/** A one-line explanation of why a turn stopped, for clients that can only show text. */
export function describeOutcome(o: TurnOutcome, sessionId: string): string {
  if (o.status === "completed") return o.text;
  const prefix = o.text ? `${o.text}\n\n` : "";
  if (o.status === "blocked") {
    const b = o.blocked!;
    const what =
      b.reason === "approval"
        ? `waits for approval: ${b.detail ?? "a tool call"}`
        : b.reason === "ask_human"
          ? `asks: ${b.detail ?? ""}. Reply in the same session to answer.`
          : `was stopped by the ${b.reason}: ${b.detail ?? ""}. Reply in the same session to continue.`;
    return `${prefix}[Sinty session ${sessionId} ${what}]`;
  }
  if (o.status === "failed") return `${prefix}[Sinty turn failed: ${o.error?.code}: ${o.error?.message}]`;
  return `${prefix}[Sinty turn was interrupted]`;
}
