import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { EventDataMap, SintyEvent } from "@sinty/sdk";
import { budgetTokens, EXTERNAL_ERROR_CODES, resolveSettings, type CheckpointPhase, type Incident, type ResolvedSupervisorSettings, type SupervisedTool, type SupervisorAction, type SupervisorSettings } from "./protocol.js";
import { maskArgs, scrubText } from "./scrub.js";

interface Failure {
  tool: string;
  code: string;
  message: string;
  hint?: string;
  args: unknown;
  /** What the call was aimed at (see targetOf): failures on different sites or files are not "the same failure". */
  target: string | undefined;
  /** The target site or the network refused (EXTERNAL_ERROR_CODES), not the call. */
  external: boolean;
  noticed: boolean;
  /** A later successful call of the same tool that corrected this one (same target): the incident's fix. */
  fixed?: { args: unknown };
}

interface TurnState {
  sessionId: string;
  /** Failures since the last human message (the counting window). */
  failures: Failure[];
  /** Every failure of the turn, for incidents. */
  allFailures: Failure[];
  argsByCall: Map<string, { tool: string; args: unknown }>;
  callCounts: Map<string, { tool: string; count: number }>;
  loopNoticed: Set<string>;
  noticesByDetector: Map<string, number>;
  totalNotices: number;
  steps: number;
  tokens: number;
  budgetWarned: boolean;
  lastResponse?: { text: string; toolCalls: number; stopReason: string; checked: boolean };
  /** Tools whose docs a notice of this turn already carried; the model has them in its history. */
  docsSent: Set<string>;
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
        const external = EXTERNAL_ERROR_CODES.has(d.code);
        const f: Failure = { tool, code: d.code, message: d.message, ...(d.hint ? { hint: d.hint } : {}), args: call?.args, target: targetOf(call?.args), external, noticed: false };
        st.failures.push(f);
        st.allFailures.push(f);
        // A site that refuses says nothing about the plugin: only the tool's own failures lead to a patch suggestion.
        if (!external) {
          const turns = this.failingTurns.get(tool) ?? new Set<string>();
          turns.add(e.turnId);
          this.failingTurns.set(tool, turns);
        }
        break;
      }
      case "tool.call.completed": {
        const d = e.data as EventDataMap["tool.call.completed"];
        const call = st.argsByCall.get(d.callId);
        if (!call) break;
        // Only a corrected version of the failed call is its fix: same tool, same target (url host, path, ...).
        // Reading another site after a failure is a different call, not a fix.
        for (const f of st.allFailures) {
          if (f.fixed || f.external || f.code === "interrupted" || f.tool !== call.tool) continue;
          if (isCorrection(f.args, call.args)) f.fixed = { args: call.args };
        }
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
        if (this.settings.checks.toolErrors) {
          const own = fresh.filter((f) => !f.external);
          const external = fresh.filter((f) => f.external);
          if (own.length) notices.push(this.failureNotice(st, own));
          if (external.length) notices.push(this.externalNotice(st, external));
        }
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
      if (n.detector === EXTERNAL_DETECTOR) {
        // Sites refusing is not the agent failing to listen: these notices never stop the turn and do not count toward
        // maxNoticesPerTurn. Past the per-detector limit they are just not sent (the tool result has the hint).
        if (count <= this.settings.maxNoticesPerDetector) out.push(n);
        continue;
      }
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
      const sameInWindow = st.failures.filter((x) => x.tool === f.tool && x.code === f.code && x.target === f.target).length;
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
      if (fLevel >= 2) lines.push(`This is failure #${sameInWindow} of ${f.tool} with ${f.code}${f.target ? " on the same target" : ""} in this turn. Do not repeat the same call; change the approach.`);
      if (fLevel === 3) {
        lines.push(
          `${f.tool} has failed in ${turnsFailing} different turns. If the plugin${tool?.plugin ? ` ${tool.plugin}` : ""} itself is wrong, read it with plugin.read and propose a fix with plugin.propose_patch; a human approves the change before it is applied.`,
        );
      }
      // Docs once per tool per turn: they stay in the model's history, repeating them only costs tokens.
      const docs = tool?.docsPath && this.settings.docsMaxChars > 0 && !st.docsSent.has(f.tool) ? this.docs(tool.docsPath, f.tool) : undefined;
      if (docs) {
        st.docsSent.add(f.tool);
        lines.push(`Tool docs (${basename(tool!.docsPath!)}${docs.section ? `, section ${docs.section}` : ""}):\n${docs.text}`);
        refs.push(tool!.docsPath!);
      }
      const similar = this.settings.useIncidents ? this.similarIncidents(f) : [];
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

  /** Failures where the target site or the network refused: what happened and what to do instead, no docs or incidents. */
  private externalNotice(st: TurnState, fresh: Failure[]): Extract<SupervisorAction, { type: "notice" }> {
    let level: 1 | 2 = 1;
    const parts: string[] = [];
    for (const f of fresh) {
      const same = st.failures.filter((x) => x.tool === f.tool && x.external && x.target === f.target).length;
      const lines = [`Tool ${f.tool} could not get a result (${f.code}: ${oneLine(scrubText(f.message), 300)}). The target site or the network refused; your call itself may be fine.`];
      if (f.hint) lines.push(`Hint from the tool: ${scrubText(f.hint)}`);
      if (f.target && same >= this.settings.repeatFailures) {
        level = 2;
        lines.push(`This is failure #${same} on the same target in this turn. Do not call it again.`);
      }
      parts.push(lines.join("\n"));
    }
    parts.push("Use another source or approach, or tell the user what blocks access.");
    return { type: "notice", detector: EXTERNAL_DETECTOR, level, text: parts.join("\n\n") };
  }

  /**
   * Solved incidents that fit this failure: same tool and code and the same message once urls are cut to their host
   * and long numbers dropped, and never a fix aimed at another site than this call.
   */
  private similarIncidents(f: Failure): Incident[] {
    if (f.external) return [];
    const key = messageKey(f.message);
    const host = f.target?.startsWith("host:") ? f.target.slice(5) : undefined;
    return this.incidents
      .filter((i) => i.tool === f.tool && i.code === f.code && !EXTERNAL_ERROR_CODES.has(i.code) && messageKey(i.message) === key)
      .filter((i) => {
        if (!host) return true;
        const hosts = urlHosts(i.fixSummary);
        return hosts.length === 0 || hosts.includes(host);
      })
      .slice(-2);
  }

  private escalate(st: TurnState, detector: string, reason: string): SupervisorAction[] {
    st.escalated = true;
    return [{ type: "escalate", detector, reason }];
  }

  private incidentsFrom(st: TurnState): NewIncident[] {
    const out: NewIncident[] = [];
    const seen = new Set<string>();
    for (const f of st.allFailures) {
      if (!f.fixed || f.external || f.code === "interrupted") continue;
      const key = `${f.tool} ${f.code} ${messageKey(f.message)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        tool: f.tool,
        code: f.code,
        message: oneLine(scrubText(f.message), 300),
        // Arguments are masked before they are summarized: typed text, secret fields and long contents never reach
        // incident memory (it is quoted in later notices and shown in the UI).
        fixSummary: scrubText(`after ${f.code} ("${oneLine(scrubText(f.message), 120)}") the call worked with arguments ${oneLine(stable(maskArgs(f.fixed.args)), 300)}`),
      });
    }
    return out;
  }

  /** The tool's section of its docs file (a heading that names the tool), else the start of the file; cut to docsMaxChars. */
  private docs(path: string, tool: string): { text: string; section?: string } | undefined {
    if (!this.docsCache.has(path)) {
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        text = "";
      }
      this.docsCache.set(path, text);
    }
    const all = this.docsCache.get(path) ?? "";
    if (!all.trim()) return undefined;
    const section = docsSection(all, tool);
    const max = this.settings.docsMaxChars;
    const cut = (t: string): string => (t.length > max ? `${t.slice(0, max)}…` : t);
    return section ? { text: cut(section), section: tool } : { text: cut(all) };
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
      docsSent: new Set(),
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

const EXTERNAL_DETECTOR = "external_error";

/** Argument keys that name what a call is aimed at, in order of preference. */
const TARGET_KEYS = ["url", "path", "file", "filePath", "command", "query", "name", "id"];

/**
 * What a call is aimed at: `host:<host>` for a url, else `<key>:<value>` of the first target-like string argument.
 * Undefined when the arguments name nothing (then any later successful call may be its correction).
 */
export function targetOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const v = a[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (key === "url") {
      try {
        return `host:${new URL(v.trim()).host.toLowerCase()}`;
      } catch {
        return `url:${v.trim()}`;
      }
    }
    return `${key}:${v.trim()}`;
  }
  return undefined;
}

/** Whether a successful call is a corrected version of a failed one: the failed call named no target, or the same one. */
export function isCorrection(failedArgs: unknown, okArgs: unknown): boolean {
  const t = targetOf(failedArgs);
  return t === undefined || t === targetOf(okArgs);
}

/** A failure message for matching: masked, one line, urls cut to their host, long numbers (ids, ports, sizes) dropped. */
export function messageKey(message: string): string {
  return oneLine(scrubText(message), 300)
    .toLowerCase()
    .replace(/https?:\/\/([^\s/"'()<>]+)[^\s"'()<>]*/g, "$1")
    .replace(/\d{4,}/g, "#")
    .slice(0, 200);
}

function urlHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([^\s/"'()<>]+)/g)) out.push(m[1]!.toLowerCase());
  return out;
}

/** The section under a markdown heading that names the tool (`## web.read`, `### \`web.read\``), up to the next heading of that level or above. */
export function docsSection(text: string, tool: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^(#{1,6})\\s+\`?${esc}\`?(?![\\w.])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  const level = head.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
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
