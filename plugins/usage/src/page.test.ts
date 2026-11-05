import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { TAB_CSP, tabHtml } from "./page.js";

test("the dashboard script parses and the page stays offline", () => {
  const html = tabHtml();
  assert.match(html, /Расход/);
  assert.match(html, /По времени/);
  assert.match(html, /По задачам/);
  assert.match(html, /По вызовам/);
  assert.match(TAB_CSP, /connect-src 'none'/);
  assert.doesNotMatch(TAB_CSP, /https:/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (typeof script !== "string") throw new Error("page has no script");
  assert.doesNotThrow(() => new Function(script));
});

test("the dashboard paints KPIs and a chart from the bridge", async () => {
  const html = tabHtml();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (typeof script !== "string") throw new Error("page has no script");
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const sent: { op: string; id?: number; path?: string }[] = [];

  class El {
    children: El[] = [];
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: unknown) => void)[]> = {};
    hidden = false;
    value = "";
    className = "";
    disabled = false;
    title = "";
    own = "";
    constructor(readonly tag: string) {}
    set textContent(v: string) {
      this.own = String(v);
      this.children = [];
    }
    get textContent(): string {
      return this.own + this.children.map((c) => c.textContent).join("");
    }
    appendChild(c: El): El {
      this.children.push(c);
      return c;
    }
    append(...cs: El[]): void {
      this.children.push(...cs);
    }
    replaceChildren(...cs: El[]): void {
      this.children = cs.flat();
    }
    addEventListener(type: string, fn: (e: unknown) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    setAttribute(k: string, v: string): void {
      this.attrs[k] = String(v);
    }
    querySelectorAll(sel: string): El[] {
      const out: El[] = [];
      const walk = (n: El): void => {
        if (sel === "button" && n.tag === "button") out.push(n);
        for (const c of n.children) walk(c);
      };
      walk(this);
      return out;
    }
    get options(): El[] {
      return this.children.filter((c) => c.tag === "option");
    }
    get classList(): { toggle: (name: string, on?: boolean) => void } {
      const el = this;
      return {
        toggle(name: string, on?: boolean) {
          const parts = new Set(el.className.split(/\s+/).filter(Boolean));
          const next = on ?? !parts.has(name);
          if (next) parts.add(name);
          else parts.delete(name);
          el.className = [...parts].join(" ");
        },
      };
    }
    getBoundingClientRect(): { width: number; left: number; height: number; top: number } {
      return { width: 200, left: 0, height: 40, top: 0 };
    }
  }

  function button(view?: string): El {
    const b = new El("button");
    if (view) b.dataset.view = view;
    return b;
  }
  const ids: Record<string, El> = {};
  for (const id of ["status", "ranges", "f-model", "f-provider", "f-agent", "clear", "k-req", "k-req-sub", "k-tok", "k-tok-sub", "k-cost", "k-cost-sub", "views", "err", "empty", "data", "view-time", "chart-title", "chart-sub", "modes", "chart-main", "legend", "chart-req", "side-title", "chart-side", "view-tasks", "task-rows", "view-calls", "chart-calls", "call-head", "call-rows", "prev", "page-label", "next", "tip"]) {
    ids[id] = new El(id === "chart-main" || id.startsWith("chart-") ? "svg" : "div");
  }
  ids.views!.append(button("time"), button("tasks"), button("calls"));
  ids["f-model"]!.append(Object.assign(new El("option"), { value: "" }));
  ids["f-provider"]!.append(Object.assign(new El("option"), { value: "" }));
  ids["f-agent"]!.append(Object.assign(new El("option"), { value: "" }));

  const document = {
    documentElement: new El("html"),
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    createTextNode: (text: string) => {
      const node = new El("#text");
      node.textContent = text;
      return node;
    },
    visibilityState: "visible",
  };

  const sandbox = {
    document,
    parent: { postMessage: (msg: { op: string; id?: number; path?: string }) => sent.push(msg) },
    addEventListener: (_type: string, fn: (e: { data: unknown }) => void) => listeners.push(fn),
    setInterval: () => 0,
    window: { innerWidth: 1024 },
    Intl,
    Date,
    Map,
    Promise,
    Object,
    Number,
    Math,
    String,
    isFinite,
    isNaN,
  };
  runInNewContext(script, sandbox, { timeout: 2000 });
  assert.equal(sent[0]?.op, "ready");
  assert.equal(document.documentElement.dataset.theme, undefined);

  const dispatch = (data: unknown): void => {
    for (const fn of listeners) fn({ data });
  };
  dispatch({ sinty: "tab/1", op: "init", theme: "dark" });
  const answered = new Set<number>();
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    for (const msg of sent) {
      if (msg.op !== "get" || msg.id === undefined || answered.has(msg.id)) continue;
      answered.add(msg.id);
      const path = msg.path ?? "";
      let data: unknown = {};
      if (path.startsWith("/status")) data = { calls: 2, backfill: "done", retainDays: 0 };
      else if (path.startsWith("/summary")) data = { requests: 2, totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedTokens: 80, hasCache: true, hasCost: false, costUsd: null, pricedCalls: 0 };
      else if (path.startsWith("/series")) data = { bucket: "hour", hasCache: true, hasCost: false, chartTruncated: false, points: [{ t: "2026-11-05T15", label: "15:00", requests: 2, inputTokens: 100, outputTokens: 50, totalTokens: 150, hit: 80, miss: 20, plain: 0, costUsd: null }], models: [{ model: "deepseek-flash", values: [150] }] };
      else if (path.startsWith("/facets")) data = { models: ["deepseek-flash"], providers: ["deepseek"], agents: [{ id: "agt", name: "Макс" }] };
      dispatch({ sinty: "tab/1", id: msg.id, ok: true, data });
    }
  }
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(ids["k-req"]!.textContent, "2");
  assert.equal(ids["k-tok"]!.textContent, "150");
  assert.equal(ids["k-cost"]!.textContent, "—");
  assert.match(ids["k-tok-sub"]!.textContent, /кэш/);
  assert.equal(ids.empty!.hidden, true);
  assert.ok(ids["chart-main"]!.children.length > 0, "main chart drew shapes");
  assert.match(ids.status!.textContent, /в индексе/);
  assert.ok(sent.some((m) => m.path?.startsWith("/series") && m.path.includes("tz=")));
});
