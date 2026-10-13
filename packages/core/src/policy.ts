import type { PolicyDecision, ToolSideEffects } from "@sinty/sdk";
import type { SintyPolicy } from "./config.js";
import { coreOwnedPaths, isInside, type SintyPaths } from "./paths.js";

export interface PolicyVerdict {
  decision: PolicyDecision;
  rule: string;
}

/** Order: agent override → tools (most specific first) → defaults by side effects. `deny` wins. */
export function evaluateTool(policy: SintyPolicy, tool: string, sideEffects: ToolSideEffects, agentId?: string): PolicyVerdict {
  const candidates: PolicyVerdict[] = [];
  const agentRules = agentId ? policy.agents[agentId]?.tools : undefined;
  const fromAgent = agentRules ? matchMostSpecific(agentRules, tool) : undefined;
  if (fromAgent) candidates.push({ decision: fromAgent.decision, rule: `agents.${agentId}.tools["${fromAgent.pattern}"]` });
  const fromTools = matchMostSpecific(policy.tools, tool);
  if (fromTools) candidates.push({ decision: fromTools.decision, rule: `tools["${fromTools.pattern}"]` });

  const denied = candidates.find((c) => c.decision === "deny");
  if (denied) return denied;
  if (candidates[0]) return candidates[0];
  return { decision: policy.defaults[sideEffects], rule: `defaults.${sideEffects}` };
}

function matchMostSpecific(rules: Record<string, PolicyDecision>, tool: string): { pattern: string; decision: PolicyDecision } | undefined {
  let best: { pattern: string; decision: PolicyDecision; score: number } | undefined;
  for (const [pattern, decision] of Object.entries(rules)) {
    if (!globMatch(pattern, tool)) continue;
    const score = pattern.replace(/\*/g, "").length + (pattern.includes("*") ? 0 : 1000);
    if (!best || score > best.score) best = { pattern, decision, score };
  }
  return best;
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "i");
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === "*" || globMatch(p, host));
}

/**
 * Hard rules for plugin filesystem grants; not configurable.
 * Writes may never overlap core-owned files or the install dir; reads may not reach config, policy, secrets or the journal.
 */
export function checkFsGrant(paths: SintyPaths, path: string, mode: "read" | "write"): string | undefined {
  const owned = mode === "write" ? coreOwnedPaths(paths) : coreOwnedPaths(paths).filter((p) => p !== paths.install);
  for (const o of owned) {
    if (isInside(path, o) || isInside(o, path)) return `${mode} grant ${path} overlaps core-owned ${o}`;
  }
  return undefined;
}

const DURATION = /^(\d+)\s*(ms|s|m|h|d)$/;

export function parseDuration(text: string): number {
  const m = DURATION.exec(text.trim());
  if (!m) throw new Error(`bad duration: ${text}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
  return n * unit;
}
