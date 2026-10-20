import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { EventDataMap, SintyEvent } from "@sinty/sdk";
import { budgetTokens, resolveSettings, type CheckpointPhase, type Incident, type ResolvedSupervisorSettings, type SupervisedTool, type SupervisorAction, type SupervisorSettings } from "./protocol.js";
import { maskArgs, scrubText } from "./scrub.js";

interface Failure {
  tool: string;
  code: string;
  message: string;
  hint?: string;
  args: unknown;
  noticed: boolean;
}

interface TurnState {
  sessionId: string;
  failures: Failure[];
  allFailures: { tool: string; code: string; message: string }[];
  argsByCall: Map<string, { tool: string; args: unknown }>;
  callCounts: Map<string, { tool: string; count: number }>;
  loopNoticed: Set<string>;
  noticesByDetector: Map<string, number>;
  totalNotices: number;
  steps: number;
  tokens: number;
  budgetWarned: boolean;
  lastResponse?: { text: string; toolCalls: number; stopReason: string; checked: boolean };
  fixes: Map<string, unknown>;
  escalated: boolean;
}

export type NewIncident = Omit<Incident, "id" | "createdAt">;

const TRUNCATED = new Set(["length", "max_tokens"]);
const IGNORED_CODES = new Set(["aborted"]);

/** Pure supervisor logic: feed events, ask for actions at checkpoints. */
export class Supervisor {
  private readonly turns = new Map<string, TurnState>();
  private readonly failingTurns = new Map<string, Set<string>>();
  private readonly docsCache = new Map<string, string>();
  private tools = new Map<string, SupervisedTool>();
  private settings: ResolvedSupervisorSettings;

  constructor(
    settings: SupervisorSettings,
    tools: SupervisedTool[],
    private readonly incidents: Incident[],
  ) {
    this.settings = resolveSettings(settings);
    this.setTools(tools);
  }

  /** New limits from the settings page; they apply from the next checkpoint. */
  setSettings(settings: SupervisorSettings): void {
    this.settings = resolveSettings(settings);
    this.docsCache.clear();
  }

  setTools(tools: SupervisedTool[]): void {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.docsCache.clear();
  }

  addIncident(incident: Incident): void {
    this.incidents.push(incident);
  }

  /** Returns incidents to store when a turn that had failures completes. */
  onEvent(e: SintyEvent): NewIncident[] {
    if (!e.turnId) return [];
    if (e.type === "turn.started") {
      this.turns.set(e.turnId, this.fresh(e.sessionId));
      return [];
    }
    const st = this.turns.get(e.turnId) ?? this.turns.set(e.turnId, this.fresh(e.sessionId)).get(e.turnId)!;
    switch (e.type) {
      case "message.user":
        this.resetWindow(st);
        break;
      case "model.response": {
        const d = e.data as EventDataMap["model.response"];
        st.steps++;
        st.tokens += budgetTokens(d.usage, this.settings.budget.count, this.settings.budget.cachedWeight);
        st.lastResponse = { text: d.text ?? "", toolCalls: d.toolCalls.length, stopReason: d.stopReason, checked: false };
        break;
      }
      case "tool.call.requested": {
        const d = e.data as EventDataMap["tool.call.requested"];
        st.argsByCall.set(d.callId, { tool: d.tool, args: d.args });
        const key = `${d.tool} ${stable(d.args)}`;
        const c = st.callCounts.get(key) ?? { tool: d.tool, count: 0 };
        c.count++;
        st.callCounts.set(key, c);
        break;
      }
      case "tool.call.failed": {
        const d = e.data as EventDataMap["tool.call.failed"];
        if (IGNORED_CODES.has(d.code)) break;
        const call = st.argsByCall.get(d.callId);
        const tool = call?.tool ?? "unknown";
        st.failures.push({ tool, code: d.code, message: d.message, ...(d.hint ? { hint: d.hint } : {}), args: call?.args, noticed: false });
        st.allFailures.push({ tool, code: d.code, message: d.message });
        const turns = this.failingTurns.get(tool) ?? new Set<string>();
        turns.add(e.turnId);
        this.failingTurns.set(tool, turns);
        break;
      }
      case "tool.call.completed": {
        const d = e.data as EventDataMap["tool.call.completed"];
        const call = st.argsByCall.get(d.callId);
        if (call && st.allFailures.some((f) => f.tool === call.tool)) st.fixes.set(call.tool, call.args);
        break;
      }
      case "turn.completed": {
        this.turns.delete(e.turnId);
        return this.incidentsFrom(st);
      }
      case "turn.failed":
      case "turn.interrupted":
        this.turns.delete(e.turnId);
        break;
    }
    return [];
  }

  checkpoint(turnId: string, phase: CheckpointPhase): SupervisorAction[] {
    const st = this.turns.get(turnId);
    if (!st || st.escalated) return [];
    const notices: Extract<SupervisorAction, { type: "notice" }>[] = [];

    if (phase === "before_model") {
      const fresh = st.failures.filter((f) => !f.noticed);
      if (fresh.length) {
        for (const f of fresh) f.noticed = true;
        if (this.settings.checks.toolErrors) notices.push(this.failureNotice(st, fresh));
      }
      if (this.settings.checks.loop) {
        for (const [key, c] of st.callCounts) {
          const stopAt = this.settings.loopBlockAfter;
          if (this.settings.escalate && stopAt > 0 && c.count >= stopAt) return this.escalate(st, "loop", `${c.tool} was called ${c.count} times with the same arguments`);
          if (c.count >= this.settings.loopThreshold && !st.loopNoticed.has(key)) {
            st.loopNoticed.add(key);
            notices.push({
              type: "notice",
              detector: "loop",
              level: 2,
              text: `You called ${c.tool} ${c.count} times with the same arguments. Repeating it will not change the result. Stop, look at what you already have, and either use it or try a different approach.`,
            });
          }
        }
      }
      const b = this.settings.budget;
      const nearSteps = b.steps !== undefined && st.steps >= Math.ceil(b.steps * b.warnAt);
      const nearTokens = b.tokens !== undefined && st.tokens >= Math.ceil(b.tokens * b.warnAt);
      if (this.settings.checks.budget && b.warnAt > 0 && b.warnAt < 1 && (nearSteps || nearTokens) && !st.budgetWarned) {
        st.budgetWarned = true;
        const counted = b.count === "all" ? "tokens" : b.count === "uncached" ? "uncached tokens" : "cost-weighted tokens";
        notices.push({
          type: "notice",
          detector: "budget",
          level: 1,
          text: `This turn has used ${st.steps} steps and ${st.tokens} ${counted}, over ${Math.round(b.warnAt * 100)}% of its budget. Finish the most important part now and give the user a result; say what is left.`,
        });
      }
    } else {
      const r = st.lastResponse;
      if (r && !r.checked && this.settings.checks.badOutput) {
        r.checked = true;
        if (TRUNCATED.has(r.stopReason)) {
          notices.push({ type: "notice", detector: "bad_output", level: 1, text: "Your last answer was cut off by the output limit. Continue from where it stopped, or give a shorter complete answer." });
        } else if (!r.text.trim() && r.toolCalls === 0) {
          notices.push({ type: "notice", detector: "bad_output", level: 1, text: "Your last answer was empty. Give the user a final answer in text, or call a tool if work remains." });
        }
      }
    }

    const out: SupervisorAction[] = [];
    for (const n of notices) {
      const count = (st.noticesByDetector.get(n.detector) ?? 0) + 1;
      st.noticesByDetector.set(n.detector, count);
      st.totalNotices++;
      if (count > this.settings.maxNoticesPerDetector || st.totalNotices > this.settings.maxNoticesPerTurn) {
        // Without escalation the turn goes on; the supervisor just stops repeating itself.
        if (!this.settings.escalate) continue;
        return this.escalate(st, n.detector, `supervisor notices did not help (${n.detector}: ${count}, total ${st.totalNotices})`);
      }
      out.push(n);
    }
    return out;
  }

  private failureNotice(st: TurnState, fresh: Failure[]): Extract<SupervisorAction, { type: "notice" }> {
    let level: 1 | 2 | 3 = 1;
    const parts: string[] = [];
    const refs: string[] = [];
    for (const f of fresh) {
      const sameInWindow = st.failures.filter((x) => x.tool === f.tool && x.code === f.code).length;
      const turnsFailing = this.failingTurns.get(f.tool)?.size ?? 0;
      const tool = this.tools.get(f.tool);
      const patchAfter = this.settings.patchAfterTurns;
      const fLevel: 1 | 2 | 3 = patchAfter > 0 && turnsFailing >= patchAfter && tool?.editable ? 3 : sameInWindow >= this.settings.repeatFailures ? 2 : 1;
      if (fLevel > level) level = fLevel;

      const lines = [`Pay attention: tool ${f.tool} failed (${f.code}: ${oneLine(scrubText(f.message), 300)}).`];
      if (f.hint) lines.push(`Hint from the tool: ${scrubText(f.hint)}`);
      if (f.code === "interrupted") {
        lines.push("The process stopped while this call was running, so it may or may not have taken effect. Check the actual state before repeating it.");
      } else if (f.code === "invalid_args") {
        lines.push("The arguments did not match the tool's input schema. Fix them; do not resend the same arguments.");
      } else if (fLevel === 1) {
        lines.push("Think about why it failed before calling it again.");
      }
      if (fLevel >= 2) lines.push(`This is failure #${sameInWindow} of ${f.tool} with ${f.code} in this turn. Do not repeat the same call; change the approach.`);
      if (fLevel === 3) {
        lines.push(
          `${f.tool} has failed in ${turnsFailing} different turns. If the plugin${tool?.plugin ? ` ${tool.plugin}` : ""} itself is wrong, read it with plugin.read and propose a fix with plugin.propose_patch; a human approves the change before it is applied.`,
        );
      }
      const docs = tool?.docsPath && this.settings.docsMaxChars > 0 ? this.docs(tool.docsPath) : undefined;
      if (docs) {
        lines.push(`Tool docs (${basename(tool!.docsPath!)}):\n${docs}`);
        refs.push(tool!.docsPath!);
      }
      const similar = this.settings.useIncidents ? this.incidents.filter((i) => i.tool === f.tool && i.code === f.code).slice(-2) : [];
      for (const i of similar) {
        lines.push(`A similar incident was solved before: ${scrubText(i.fixSummary)}`);
        refs.push(`incident:${i.id}`);
      }
      parts.push(lines.join("\n"));
    }
    parts.push("Propose a fix: correct the arguments, choose another approach, or explain to the user what is blocking you.");
    const allInvalid = fresh.every((f) => f.code === "invalid_args");
    return { type: "notice", detector: allInvalid ? "invalid_args" : "tool_error", level, text: parts.join("\n\n"), ...(refs.length ? { refs } : {}) };
  }

  private escalate(st: TurnState, detector: string, reason: string): SupervisorAction[] {
    st.escalated = true;
    return [{ type: "escalate", detector, reason }];
  }

  private incidentsFrom(st: TurnState): NewIncident[] {
    const out: NewIncident[] = [];
    const seen = new Set<string>();
    for (const f of st.allFailures) {
      const key = `${f.tool} ${f.code}`;
      if (seen.has(key) || !st.fixes.has(f.tool) || f.code === "interrupted") continue;
      seen.add(key);
      out.push({
        tool: f.tool,
        code: f.code,
        message: oneLine(scrubText(f.message), 300),
        // Arguments are masked before they are summarized: typed text, secret fields and long contents never reach
        // incident memory (it is quoted in later notices and shown in the UI).
        fixSummary: scrubText(`after ${f.code} ("${oneLine(scrubText(f.message), 120)}") the call worked with arguments ${oneLine(stable(maskArgs(st.fixes.get(f.tool))), 300)}`),
      });
    }
    return out;
  }

  private docs(path: string): string | undefined {
    if (!this.docsCache.has(path)) {
      let text = "";
      try {
        text = readFileSync(path, "utf8").slice(0, this.settings.docsMaxChars);
      } catch {
        text = "";
      }
      this.docsCache.set(path, text);
    }
    return this.docsCache.get(path) || undefined;
  }

  private fresh(sessionId: string): TurnState {
    return {
      sessionId,
      failures: [],
      allFailures: [],
      argsByCall: new Map(),
      callCounts: new Map(),
      loopNoticed: new Set(),
      noticesByDetector: new Map(),
      totalNotices: 0,
      steps: 0,
      tokens: 0,
      budgetWarned: false,
      fixes: new Map(),
      escalated: false,
    };
  }

  /** A human message opens a new window: counters and budgets restart. */
  private resetWindow(st: TurnState): void {
    st.failures = [];
    st.callCounts.clear();
    st.loopNoticed.clear();
    st.noticesByDetector.clear();
    st.totalNotices = 0;
    st.steps = 0;
    st.tokens = 0;
    st.budgetWarned = false;
    st.escalated = false;
  }
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
