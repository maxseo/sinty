import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, readSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "@sinty/sdk";

export const PILOT_LIFETIME_MS = 20 * 60_000;
const ref = z.string().min(1).max(256).describe("CSS selector from current state controls, e.g. input[name=\"name\"], textarea[name=\"note\"], input[type=\"file\"] or a[download]; not CUA refs/native IDs");
export const browserPilotInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare") }).strict(),
  z.object({ action: z.literal("state") }).strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(4096).optional() }).strict(),
  z.object({ action: z.literal("click"), ref }).strict(),
  z.object({ action: z.literal("type"), ref, text: z.string().max(10_000) }).strict(),
  z.object({ action: z.literal("select"), ref, value: z.string().max(1000) }).strict(),
  z.object({ action: z.literal("scroll"), delta: z.number().int().min(-2000).max(2000) }).strict(),
  z.object({ action: z.literal("attach"), ref, file: z.string().min(1).max(512) }).strict(),
  z.object({ action: z.literal("download"), ref }).strict(),
]);
export interface BrowserExecution { readonly ownerId: string; readonly agentId: string; readonly sessionId: string; readonly projectId: string; readonly workspace: string }
export type BrowserNativeTool = "get_browser_state" | "browser_navigate" | "browser_click" | "browser_type" | "browser_select" | "browser_pointer" | "browser_set_input_files" | "browser_download";
/** Internal trusted adapter contract, NOT CUA's unverified native response schema.
 * No production adapter is enabled until isolated-fixture output/cleanup verification.
 */
export interface BrowserPilotDriver {
  prepare(args: { allow_launch: true; profile: { mode: "isolated_named"; name: string }; session: string; fixture?: string; workspace?: string; scope?: "public" }, signal: AbortSignal): Promise<{ targetId: string; tabId: string }>;
  call(tool: BrowserNativeTool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** True only when the dedicated native worker/browser has actually closed. */
  close(session: string): Promise<boolean>;
}
type Mode = "inactive" | "agent" | "pausing" | "manual" | "closing" | "quarantined";
interface Lease { uploads: Set<string>; execution: BrowserExecution; profile: string; nativeSession: string; fixture: string; scope?: "public"; currentUrl?: string; expires: number; mode: Mode; target?: { targetId: string; tabId: string }; active?: AbortController; lock?: string; timer: ReturnType<typeof setTimeout> }
export class BrowserPilotError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const denied = (code: string, message: string): never => { throw new BrowserPilotError(code, message); };

export class BrowserPilot {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly data: string, private readonly driver?: BrowserPilotDriver, private readonly enabled: () => boolean = () => true) {}
  get ready(): boolean { return !!this.driver && this.enabled(); }
  list(ownerId: string): unknown[] { return [...this.leases.values()].filter((l) => l.execution.ownerId === ownerId).map((l) => this.status(ownerId, l.execution.sessionId)); }
  has(sessionId: string): boolean { return this.leases.has(sessionId); }
  profile(ownerId: string, agentId: string, projectId = "", scope = ""): string { return "sinty-" + createHash("sha256").update(resolve(this.data) + "\0" + ownerId + "\0" + agentId + "\0" + projectId + (scope ? "\0" + scope : "")).digest("hex").slice(0, 48); }
  grant(execution: BrowserExecution, fixture: string, uploads: string[] = [], scope?: "public"): unknown {
    const url = scope === "public" ? undefined : new URL(fixture);
    if (url && (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/browser-pilot-fixture" || url.search || url.hash || url.username || url.password)) denied("fixture_only", "Only the server-owned local fixture is allowed");
    if (realpathSync(execution.workspace) !== execution.workspace) denied("workspace_changed", "Canonical project workspace required");
    for (const file of uploads) this.workspaceFile(execution.workspace, file);
    const profile = this.profile(execution.ownerId, execution.agentId, execution.projectId, scope);
    if ([...this.leases.values()].some((l) => l.profile === profile) || this.has(execution.sessionId)) denied("profile_busy", "Profile already leased");
    const lease: Lease = { uploads: new Set(uploads), execution: Object.freeze({ ...execution }), profile, nativeSession: "pilot-" + randomUUID(), fixture: url?.href ?? "", ...(scope ? { scope } : {}), expires: Date.now() + PILOT_LIFETIME_MS, mode: "inactive", timer: setTimeout(() => void this.release(execution.ownerId, execution.sessionId), PILOT_LIFETIME_MS) };
    lease.timer.unref(); this.leases.set(execution.sessionId, lease);
    return this.status(execution.ownerId, execution.sessionId);
  }
  grantPublic(execution: BrowserExecution, uploads: string[] = []): unknown { return this.grant(execution, "", uploads, "public"); }
  scope(ownerId: string, sessionId: string): "fixture" | "public" { return this.owned(ownerId, sessionId).scope ?? "fixture"; }
  allowUploads(ownerId: string, sessionId: string, files: string[]): void { const l = this.owned(ownerId, sessionId); for (const file of files) { this.workspaceFile(l.execution.workspace, file); l.uploads.add(file); } }
  execution(ownerId: string, sessionId: string): BrowserExecution { const lease = this.owned(ownerId, sessionId); if (Date.now() >= lease.expires) denied("lease_expired", "Pilot lease expired"); return lease.execution; }
  status(ownerId: string, sessionId: string): unknown {
    const l = this.owned(ownerId, sessionId);
    return { ...l.execution, mode: l.mode, pending: !!l.active, ready: this.ready, reason: this.ready ? null : "driver_contract_unverified", expires: l.expires, profile: l.profile, fixture: l.fixture, scope: l.scope ?? "fixture", url: l.currentUrl ?? null };
  }
  pause(ownerId: string, sessionId: string): unknown { const l = this.owned(ownerId, sessionId); if (l.mode === "quarantined" || l.mode === "closing") return this.status(ownerId, sessionId); l.mode = l.active ? "pausing" : "manual"; return this.status(ownerId, sessionId); }
  resume(ownerId: string, sessionId: string): unknown { const l = this.owned(ownerId, sessionId); this.execution(ownerId, sessionId); if (l.mode !== "manual" || l.active) denied("not_manual", "Wait for the in-flight operation to finish"); l.mode = l.target ? "agent" : "inactive"; return this.status(ownerId, sessionId); }
  async release(ownerId: string, sessionId: string): Promise<unknown> {
    const l = this.owned(ownerId, sessionId); if (l.mode === "closing") return this.status(ownerId, sessionId); clearTimeout(l.timer); l.mode = "closing"; l.active?.abort();
    // Bound the control response. Unknown native completion keeps the on-disk lock quarantined.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = !l.lock || await Promise.race([this.driver?.close(l.nativeSession).catch(() => false) ?? Promise.resolve(false), new Promise<false>((r) => { timer = setTimeout(() => r(false), 5000); })]);
    if (timer) clearTimeout(timer);
    if (!closed || l.active) { l.mode = "quarantined"; return this.status(ownerId, sessionId); }
    if (l.lock) { unlinkSync(l.lock); delete l.lock; }
    this.leases.delete(sessionId); return { mode: "inactive", pending: false, released: true };
  }
  async stop(): Promise<void> { await Promise.all([...this.leases.values()].map((l) => this.release(l.execution.ownerId, l.execution.sessionId))); }
  async call(execution: BrowserExecution | undefined, raw: unknown, parent?: AbortSignal): Promise<unknown> {
    if (!execution) denied("no_execution", "Browser pilot requires an owner-dispatched execution");
    const e = execution!, l = this.owned(e.ownerId, e.sessionId);
    if (Object.keys(l.execution).some((key) => l.execution[key as keyof BrowserExecution] !== e[key as keyof BrowserExecution])) denied("wrong_execution", "Browser lease does not belong to this execution");
    const parsed = browserPilotInput.safeParse(raw); if (!parsed.success) denied("invalid_args", "Unsupported browser pilot action/arguments"); const a = parsed.data!;
    if (a.action === "close") return this.release(e.ownerId, e.sessionId);
    this.execution(e.ownerId, e.sessionId);
    if (!this.driver) denied("driver_contract_unverified", "Native browser output contract must be verified on the isolated fixture first");
    if (l.active) denied("browser_busy", "Browser paused while another operation is pending; дождитесь завершения операции.");
    if (l.mode === "manual" || l.mode === "pausing") denied("browser_manual", "Browser paused by owner; ручное управление не перехватывается. Возврат агенту — только владельцем.");
    if (l.mode === "quarantined" || l.mode === "closing") denied("browser_quarantined", "Browser paused for unconfirmed cleanup, not manual takeover. Неизвестен результат предыдущего действия; закройте только этот браузер перед повторным prepare.");
    if (parent?.aborted) throw new DOMException("aborted", "AbortError");
    const controller = new AbortController(); l.active = controller;
    const abort = (): void => { controller.abort(); l.mode = "quarantined"; };
    parent?.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout>;
    let enteredNative = false;
    const native = (tool: BrowserNativeTool, args: Record<string, unknown>): Promise<unknown> => { enteredNative = true; return this.driver!.call(tool, args, controller.signal); };
    const work = (async () => {
      if (a.action === "prepare") {
        if (l.target) { if (l.scope === "public") return { prepared: true, reused: true, ownerSelectedUploads: [...l.uploads] }; denied("already_prepared", "Already prepared; reuse this owned target"); }
        const dir = join(this.data, "browser-pilot"); mkdirSync(dir, { recursive: true });
        const lock = join(dir, l.profile + ".lock");
        try { const fd = openSync(lock, "wx"); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, session: l.nativeSession })); } finally { closeSync(fd); } l.lock = lock; } catch { denied("profile_locked", "Profile lock exists; confirmed native cleanup is required, never auto-remove a stale lock"); }
        enteredNative = true;
        const target = await this.driver!.prepare({ allow_launch: true, profile: { mode: "isolated_named", name: l.profile }, session: l.nativeSession, fixture: l.fixture, workspace: e.workspace, ...(l.scope ? { scope: l.scope } : {}) }, controller.signal);
        const validated = z.object({ targetId: ref, tabId: ref }).strict().safeParse(target);
        if (!validated.success) { l.mode = "quarantined"; denied("driver_contract_invalid", "Unverified/malformed owned browser target"); }
        l.target = validated.data!; if (l.mode === "inactive") l.mode = "agent";
        return { prepared: true, ...(l.scope ? { ownerSelectedUploads: [...l.uploads] } : {}) };
      }
      if (!l.target) denied("not_prepared", "Prepare the isolated browser first");
      const base = { session: l.nativeSession, target_id: l.target!.targetId, tab_id: l.target!.tabId };
      switch (a.action) {
        case "state": { const state = await native("get_browser_state", { ...base, include_screenshot: true }); if (state && typeof state === "object" && "url" in state && typeof state.url === "string") l.currentUrl = state.url.slice(0, 4096); return state; }
        case "goto": {
          let url = l.fixture;
          if (l.scope === "public") { if (!a.url) denied("url_required", "Provide the public http(s) URL in goto"); const u = new URL(a.url!); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) denied("invalid_url", "Public http(s) URL without embedded credentials required"); url = u.href; }
          else if (a.url && a.url !== l.fixture) denied("invalid_args", "Unsupported browser pilot fixture URL");
          const result = await native("browser_navigate", { ...base, url }); const display = new URL(url); display.search = ""; display.hash = ""; l.currentUrl = display.href; return result;
        }
        case "click": return native("browser_click", { ...base, ref: a.ref, delivery_mode: "background", input_route: "trusted" });
        case "type": return native("browser_type", { ...base, ref: a.ref, text: a.text, replace: true, mode: "insert_text" });
        case "select": return native("browser_select", { ...base, ref: a.ref, value: a.value });
        case "scroll": return native("browser_pointer", { ...base, action: "scroll", delta_y: a.delta, delivery_mode: "background", input_route: "trusted" });
        case "attach": {
          if (!l.uploads.has(a.file)) denied("file_not_granted", "Owner must explicitly select this project upload first");
          const source = this.workspaceFile(e.workspace, a.file); const dir = this.workspaceDirectory(e.workspace, join("_work", "browser-pilot", l.nativeSession, randomUUID()));
          const staged = join(dir, basename(source)); this.stageFile(source, staged);
          return native("browser_set_input_files", { ...base, ref: a.ref, files: [staged] });
        }
        case "download": return native("browser_download", { ...base, ref: a.ref, destination_root: this.workspaceDirectory(e.workspace, join("_out", "browser-pilot", l.nativeSession)) });
      }
    })();
    // An abort/timeout is not proof a native action stopped. Never permit manual/agent overlap after it.
    void work.then(() => { delete l.active; if (l.mode === "pausing") l.mode = "manual"; }, (error) => { delete l.active; const recoverableRead = a.action === "state" && !controller.signal.aborted && ["snapshot_timeout", "snapshot_unstable"].includes(String((error as {code?:unknown})?.code)); if (recoverableRead) { if (l.mode === "pausing") l.mode = "manual"; } else if (enteredNative || controller.signal.aborted) l.mode = "quarantined"; });
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort(); reject(new BrowserPilotError("operation_timeout", "Native operation outcome unknown; browser quarantined")); }, 30_000); })]); }
    finally { clearTimeout(timeout!); parent?.removeEventListener("abort", abort); }
  }
  private owned(ownerId: string, sessionId: string): Lease { const l = this.leases.get(sessionId); if (!l) return denied("browser_session_missing", "No browser lease for this owner/session; агент должен выполнить prepare, а не просить владельца искать сессию."); if (l.execution.ownerId !== ownerId) return denied("wrong_owner", "No browser lease for this owner/session"); return l; }
  private inside(root: string, path: string): boolean { const r = relative(root, path); return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r); }
  private workspaceFile(root: string, file: string): string {
    if (isAbsolute(file) || file.includes(":") || file.includes("\\") || file.split("/").some((p) => p === ".." || !p)) return denied("outside_workspace", "Use a relative project file, no traversal/device/ADS paths");
    if (realpathSync(root) !== root) return denied("workspace_changed", "Workspace changed");
    const path = resolve(root, file); let current = root;
    for (const part of relative(root, path).split(sep)) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) return denied("outside_workspace", "Symlinks/junctions are not accepted"); }
    if (!this.inside(root, realpathSync(path)) || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1 || lstatSync(path).size > 16_000_000) return denied("outside_workspace", "Upload must be a project regular file <=16MB");
    return path;
  }
  private stageFile(source: string, destination: string): void {
    const expected = lstatSync(source), fd = openSync(source, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_000_000 || stat.dev !== expected.dev || stat.ino !== expected.ino) denied("upload_changed", "Project file changed before staging");
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) denied("upload_changed", "Project file changed during staging"); offset += n; }
      if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) denied("upload_changed", "Project file grew during staging");
      const out = openSync(destination, "wx"); try { writeFileSync(out, bytes); } finally { closeSync(out); }
    } finally { closeSync(fd); }
  }
  private workspaceDirectory(root: string, file: string): string {
    if (realpathSync(root) !== root) return denied("workspace_changed", "Workspace changed"); let current = root;
    for (const part of file.split(sep)) { current = join(current, part); if (!existsSync(current)) mkdirSync(current); const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory() || !this.inside(root, realpathSync(current))) return denied("outside_workspace", "Output/staging directory escaped the project"); }
    return current;
  }
}

/** Pilot eligibility is not project membership: an authenticated owner may select a real roster agent for an empty project lease, just as for a new project chat. Explicit member lists stay restrictive. */
export function browserPilotAgentIds(agents: readonly { id: string }[], project: { agentIds: readonly string[] } | undefined): string[] {
  if (!project) return [];
  const assigned = new Set(project.agentIds);
  return agents.filter(agent => assigned.size === 0 || assigned.has(agent.id)).map(agent => agent.id);
}
