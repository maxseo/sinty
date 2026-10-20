import type { TurnInfo } from "@sinty/sdk";
import { armOverrides, type RecallOverrides } from "./memory-router.js";
import { estimateTokens } from "./memory.js";
import type { Sinty } from "./sinty.js";

export interface EvalLabel {
  query: string;
  /** A hit when any of these substrings (case-insensitive) appears in a recalled record. */
  expect: string[];
}

export interface EvalArmReport {
  arm: string;
  queries: number;
  labeled: number;
  hits: number;
  /** hits / labeled, or null without labels. */
  hitRate: number | null;
  /** Mean tokens of the memory blocks (profile block + recalled blocks) per query. */
  meanMemoryTokens: number;
  meanRecalledTokens: number;
  meanRecords: number;
  p50Ms: number;
  p95Ms: number;
}

export interface EvalOptions {
  labels?: EvalLabel[] | undefined;
  /** Arm names to run: "baseline" (config as is, recall forced on) and/or names of memory.experiments arms. Default: all. */
  arms?: string[] | undefined;
  /** How many stored user messages to replay when no labels are given. Default 200. */
  limit?: number | undefined;
}

/** Replays queries against the current memory without calling the chat model and without writing to the journal. */
export async function evalMemory(sinty: Sinty, opts: EvalOptions = {}): Promise<EvalArmReport[]> {
  const labels = opts.labels ?? [];
  const queries: { query: string; expect?: string[] }[] = labels.length ? labels.map((l) => ({ query: l.query, expect: l.expect })) : storedQueries(sinty, opts.limit ?? 200).map((query) => ({ query }));
  const arms: { name: string; overrides: RecallOverrides }[] = [{ name: "baseline", overrides: {} }];
  for (const x of sinty.config.memory.experiments ?? []) for (const a of x.arms) arms.push({ name: `${x.name}=${a.name}`, overrides: armOverrides(a) });
  const selected = opts.arms?.length ? arms.filter((a) => opts.arms!.some((n) => n === a.name || a.name.endsWith(`=${n}`))) : arms;
  const agentId = sinty.config.agent.name;
  const profileTokens = estimateTokens([{ role: "system", content: sinty.memory.builtin.block({ agentId, chatId: "" }) }]);
  const reports: EvalArmReport[] = [];
  for (const arm of selected) {
    // An arm that turns automatic recall off still gets measured: eval asks "what would recall find".
    const overrides: RecallOverrides = { ...arm.overrides, auto: true };
    const ms: number[] = [];
    let hits = 0;
    let labeled = 0;
    let recalledTokens = 0;
    let records = 0;
    for (const [i, q] of queries.entries()) {
      const turn: TurnInfo = { sessionId: `eval-${i}`, turnId: `eval-${arm.name}-${i}`, agentId, userId: sinty.config.agent.userId, text: q.query, arm: arm.name };
      const plan = await sinty.memory.plan(turn, overrides);
      const t0 = Date.now();
      const r = plan ? await sinty.memory.runPlan(turn, plan, overrides, false, false) : { records: [], tokens: 0 };
      ms.push(Date.now() - t0);
      recalledTokens += r.tokens;
      records += r.records.length;
      if (q.expect?.length) {
        labeled++;
        const texts = r.records.map((x) => x.text.toLowerCase());
        if (q.expect.some((e) => texts.some((t) => t.includes(e.toLowerCase())))) hits++;
      }
    }
    const n = queries.length || 1;
    reports.push({
      arm: arm.name,
      queries: queries.length,
      labeled,
      hits,
      hitRate: labeled ? hits / labeled : null,
      meanMemoryTokens: Math.round(profileTokens + recalledTokens / n),
      meanRecalledTokens: Math.round(recalledTokens / n),
      meanRecords: Math.round((records / n) * 10) / 10,
      p50Ms: percentile(ms, 0.5),
      p95Ms: percentile(ms, 0.95),
    });
  }
  return reports;
}

function storedQueries(sinty: Sinty, limit: number): string[] {
  return sinty.journal
    .recentEvents(["message.user"], limit)
    .map((e) => (e.data as { text?: string }).text ?? "")
    .filter((t) => t.trim() && !t.startsWith("[supervisor]"));
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function formatEval(reports: EvalArmReport[]): string {
  const rows = [["arm", "queries", "hit rate", "memory tokens", "recalled tokens", "records", "p50 ms", "p95 ms"]];
  for (const r of reports) {
    rows.push([r.arm, String(r.queries), r.hitRate === null ? "n/a" : `${(r.hitRate * 100).toFixed(1)}% (${r.hits}/${r.labeled})`, String(r.meanMemoryTokens), String(r.meanRecalledTokens), String(r.meanRecords), String(r.p50Ms), String(r.p95Ms)]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((v, c) => v.padEnd(widths[c]!)).join("  ")).join("\n");
}
