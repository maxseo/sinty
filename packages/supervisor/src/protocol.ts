import type { SintyEvent, ToolSideEffects } from "@sinty/sdk";

/** How the turn budget counts tokens. See budgetTokens(). */
export type BudgetCount = "all" | "uncached" | "weighted";

export interface SupervisorChecks {
  /** Notices after failed tool calls (tool_error, invalid_args). */
  toolErrors: boolean;
  /** Notices (and escalation) for identical repeated calls. */
  loop: boolean;
  /** The warning notice when the turn nears its budget. */
  budget: boolean;
  /** Notices for an empty or cut-off answer. */
  badOutput: boolean;
}

export interface SupervisorSettings {
  /** Identical calls (same tool and arguments) before a loop notice. */
  loopThreshold: number;
  /** Identical calls before the turn is stopped; 0 never stops. Default loopThreshold + 2. */
  loopBlockAfter?: number;
  maxNoticesPerTurn: number;
  maxNoticesPerDetector: number;
  /** Tool docs added to a failure notice, in characters; 0 adds none. */
  docsMaxChars: number;
  /** Stop the turn when notices exceed their limits (or a loop passes loopBlockAfter). False: stop sending notices, never stop the turn. Default true. */
  escalate?: boolean;
  /** Failures of the same tool and code in a turn before the notice says "do not repeat". Default 2. */
  repeatFailures?: number;
  /** Turns a tool has failed in before the notice suggests a plugin patch (editable plugins only); 0 never. Default 3. */
  patchAfterTurns?: number;
  /** Quote similar solved incidents in failure notices. Default true. */
  useIncidents?: boolean;
  checks?: Partial<SupervisorChecks>;
  budget: {
    steps?: number | undefined;
    tokens?: number | undefined;
    /** Share of the budget that triggers the warning notice (0.8 = 80%). Default 0.8. */
    warnAt?: number | undefined;
    count?: BudgetCount | undefined;
    /** Weight of cached prompt tokens when count is "weighted". Default 0.1. */
    cachedWeight?: number | undefined;
  };
}

export type ResolvedSupervisorSettings = Required<Omit<SupervisorSettings, "checks" | "budget">> & {
  checks: SupervisorChecks;
  budget: { steps?: number | undefined; tokens?: number | undefined; warnAt: number; count: BudgetCount; cachedWeight: number };
};

export function resolveSettings(s: SupervisorSettings): ResolvedSupervisorSettings {
  return {
    loopThreshold: s.loopThreshold,
    loopBlockAfter: s.loopBlockAfter ?? s.loopThreshold + 2,
    maxNoticesPerTurn: s.maxNoticesPerTurn,
    maxNoticesPerDetector: s.maxNoticesPerDetector,
    docsMaxChars: s.docsMaxChars,
    escalate: s.escalate ?? true,
    repeatFailures: s.repeatFailures ?? 2,
    patchAfterTurns: s.patchAfterTurns ?? 3,
    useIncidents: s.useIncidents ?? true,
    checks: { toolErrors: true, loop: true, budget: true, badOutput: true, ...(s.checks ?? {}) },
    budget: { steps: s.budget.steps, tokens: s.budget.tokens, warnAt: s.budget.warnAt ?? 0.8, count: s.budget.count ?? "weighted", cachedWeight: s.budget.cachedWeight ?? 0.1 },
  };
}

/**
 * Tokens one model call adds to the turn budget.
 * - "all": every prompt and output token (cached prompt tokens count in full).
 * - "uncached": prompt tokens not read from the provider's cache, plus output.
 * - "weighted" (default): uncached prompt + output + cached prompt × cachedWeight (0.1 ≈ the price of a cache hit at
 *   DeepSeek and Anthropic), so the budget follows cost rather than context length.
 * Providers that report no cache numbers count as "all".
 */
export function budgetTokens(u: { inputTokens: number; outputTokens: number; cachedTokens?: number | undefined }, count: BudgetCount = "weighted", cachedWeight = 0.1): number {
  const cached = Math.min(Math.max(u.cachedTokens ?? 0, 0), u.inputTokens);
  if (count === "all") return u.inputTokens + u.outputTokens;
  const uncached = u.inputTokens - cached + u.outputTokens;
  return count === "uncached" ? uncached : Math.round(uncached + cached * cachedWeight);
}

export interface SupervisedTool {
  name: string;
  plugin?: string;
  sideEffects: ToolSideEffects;
  /** Absolute path to the docs file, or to the plugin README. */
  docsPath?: string;
  editable: boolean;
}

export interface Incident {
  id: string;
  tool: string;
  code: string;
  message: string;
  fixSummary: string;
  createdAt: string;
}

export type CheckpointPhase = "before_model" | "before_complete";

export type SupervisorAction =
  | { type: "notice"; detector: string; level: 1 | 2 | 3; text: string; refs?: string[] }
  | { type: "escalate"; detector: string; reason: string };

export type ToSupervisor =
  | { t: "init"; settings: SupervisorSettings; tools: SupervisedTool[]; incidents: Incident[] }
  | { t: "tools"; tools: SupervisedTool[] }
  | { t: "settings"; settings: SupervisorSettings }
  | { t: "event"; event: SintyEvent }
  | { t: "incident.stored"; incident: Incident }
  | { t: "checkpoint"; id: number; sessionId: string; turnId: string; phase: CheckpointPhase };

export type FromSupervisor =
  | { t: "ready" }
  | { t: "actions"; id: number; actions: SupervisorAction[] }
  | { t: "incident.resolved"; sessionId: string; turnId: string; incident: Omit<Incident, "id" | "createdAt"> }
  | { t: "log"; level: "info" | "warn" | "error"; msg: string };
