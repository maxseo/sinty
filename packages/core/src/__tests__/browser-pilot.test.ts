import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserPilot, type BrowserExecution, type BrowserPilotDriver } from "../browser-pilot.js";
import { saveAgent, saveProject, ensureProjectDirs, projectDir } from "../roster.js";
import { createApp } from "../api/server.js";
import { Sinty } from "../sinty.js";
import { tempHome, testConfig, boot } from "./helpers.js";
import { policySchema } from "../config.js";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwN8AAAAASUVORK5CYII=";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sinty-browser-pilot-")), workspace = join(dir, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "test.txt"), "synthetic project file");
  const calls: { tool: string; args: any }[] = [];
  const driver: BrowserPilotDriver = { async prepare(args) { calls.push({ tool: "browser_prepare", args }); return { targetId: "owned-target", tabId: "owned-tab" }; }, async call(tool, args) { calls.push({ tool, args }); return { content: [{ type: "image", mimeType: "image/png", data: PNG }] }; }, async close(session) { calls.push({ tool: "end_session", args: { session } }); return true; } };
  const execution: BrowserExecution = { ownerId: "owner", agentId: "actual-agent-uuid", sessionId: "actual-session", projectId: "actual-project", workspace: realpathSync(workspace) };
  const broker = new BrowserPilot(dir, driver); const grant = () => broker.grant(execution, "http://127.0.0.1:3180/browser-pilot-fixture", ["test.txt"]);
  return { dir, workspace, calls, driver, execution, broker, grant };
}

test("browser pilot: isolated named preparation, stable profile and no raw native identifiers in model input", async (t) => {
  const f = fixture(); t.after(async () => { await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); }); f.grant();
  await f.broker.call(f.execution, { action: "prepare" }); await f.broker.call(f.execution, { action: "goto" }); await f.broker.call(f.execution, { action: "scroll", delta: 200 });
  assert.deepEqual(Object.keys(f.calls[0]!.args).sort(), ["allow_launch", "fixture", "profile", "session", "workspace"]); assert.equal(f.calls[0]!.args.profile.mode, "isolated_named");
  assert.equal(f.calls[1]!.args.target_id, "owned-target"); assert.equal(f.calls[1]!.args.url, "http://127.0.0.1:3180/browser-pilot-fixture"); assert.equal(f.calls[2]!.args.action, "scroll");
  for (const action of [{ action: "run_script", script: "bad" }, { action: "desktop" }, { action: "prepare", strategy: { kind: "existing_profile" } }, { action: "click", ref: "p1:1", target_id: "foreign" }, { action: "goto", url: "https://example.com" }]) await assert.rejects(f.broker.call(f.execution, action), /Unsupported/);
  await assert.rejects(f.broker.call({ ...f.execution, agentId: "other" }, { action: "state" }), /does not belong/);
  await assert.rejects(f.broker.call({ ...f.execution, ownerId: "other" }, { action: "state" }), /No browser lease/);
  await assert.rejects(f.broker.call(undefined, { action: "state" }), /owner-dispatched/);
  await assert.rejects(f.broker.call({ ...f.execution, sessionId: "foreign-session" }, { action: "state" }), /No browser lease/);
  assert.equal(f.calls.length, 3);
});
test("browser pilot: only owner-selected project uploads, scoped downloads and junction rejection", async (t) => {
  const f = fixture(); t.after(async () => { await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); }); f.grant(); await f.broker.call(f.execution, { action: "prepare" });
  await f.broker.call(f.execution, { action: "attach", ref: "p1:1", file: "test.txt" }); const upload = f.calls.at(-1)!.args.files[0]; assert.equal(readFileSync(upload, "utf8"), "synthetic project file"); assert.ok(upload.startsWith(f.workspace));
  await assert.rejects(f.broker.call(f.execution, { action: "attach", ref: "p1:1", file: "../secret.txt" }), /explicitly select/);
  await assert.rejects(f.broker.call(f.execution, { action: "attach", ref: "p1:1", file: "C:/secret.txt" }), /explicitly select/);
  await f.broker.call(f.execution, { action: "download", ref: "p1:2" }); assert.ok(f.calls.at(-1)!.args.destination_root.startsWith(join(f.workspace, "_out", "browser-pilot")));
  const outside = join(f.dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "synthetic outside"); symlinkSync(outside, join(f.workspace, "junction"), "junction");
  const second = new BrowserPilot(join(f.dir, "other"), f.driver);
  assert.throws(() => second.grant({ ...f.execution, sessionId: "other" }, "http://127.0.0.1:3180/browser-pilot-fixture", ["junction/secret.txt"]), /junctions/);
  assert.throws(() => second.grant({ ...f.execution, sessionId: "other" }, "http://127.0.0.1:3180/browser-pilot-fixture", ["../outside/secret.txt"]), /traversal/);
});
test("browser pilot: in-flight handoff stays pending, then manual blocks automation", async (t) => {
  const f = fixture(); t.after(async () => { await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); }); let done!: (v: unknown) => void;
  f.driver.call = async () => new Promise((r) => { done = r; }); f.grant(); await f.broker.call(f.execution, { action: "prepare" });
  const pending = f.broker.call(f.execution, { action: "state" });
  assert.equal((f.broker.pause("owner", f.execution.sessionId) as any).mode, "pausing"); await assert.rejects(f.broker.call(f.execution, { action: "state" }), /paused/);
  done({ content: [] }); await pending; assert.equal((f.broker.status("owner", f.execution.sessionId) as any).mode, "manual");
  await assert.rejects(f.broker.call(f.execution, { action: "state" }), /paused/); f.broker.resume("owner", f.execution.sessionId);
  assert.equal((f.broker.status("owner", f.execution.sessionId) as any).mode, "agent");
});
test("browser pilot: native error quarantines; unclean restart retains lock, clean release preserves profile mapping", async (t) => {
  const f = fixture(); t.after(async () => { await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); }); f.grant(); await f.broker.call(f.execution, { action: "prepare" });
  const other = new BrowserPilot(f.dir, f.driver); other.grant({ ...f.execution, sessionId: "restart" }, "http://127.0.0.1:3180/browser-pilot-fixture");
  await assert.rejects(other.call({ ...f.execution, sessionId: "restart" }, { action: "prepare" }), /lock exists/); await other.stop();
  f.driver.call = async () => { throw Error("synthetic unknown native failure"); }; await assert.rejects(f.broker.call(f.execution, { action: "state" }));
  assert.equal((f.broker.status("owner", f.execution.sessionId) as any).mode, "quarantined"); await f.broker.release("owner", f.execution.sessionId);
  const restarted = new BrowserPilot(f.dir, f.driver); assert.equal(restarted.profile("owner", f.execution.agentId), f.broker.profile("owner", f.execution.agentId));
});
test("browser pilot API: auth/CSRF and missing native contract fail closed without rights", async (t) => {
  const { home } = tempHome(); const sinty = await boot(home, []); t.after(async () => { await sinty.stop(); await rm(home, { recursive: true, force: true }); });
  const app = createApp(sinty), auth = { authorization: "Bearer " + sinty.secrets.get("api.token"), "content-type": "application/json" };
  assert.equal((await app.request("http://127.0.0.1:3180/v1/browser-pilot")).status, 401);
  assert.equal((await app.request("http://127.0.0.1:3180/v1/browser-pilot", { headers: { ...auth, origin: "https://foreign.example" } })).status, 403);
  const response = await app.request("http://127.0.0.1:3180/v1/browser-pilot", { method: "POST", headers: auth, body: JSON.stringify({ agentId: "x", projectId: "x" }) }); assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, "driver_contract_unverified");
  const fixture = await app.request("http://127.0.0.1:3180/browser-pilot-fixture"); assert.ok(fixture.headers.get("content-security-policy")?.includes("form-action 'none'")); assert.ok((await fixture.text()).includes('type="submit" disabled'));
});
test("browser pilot scheduler: real owner/roster execution overrides forged chat metadata and denies alternate tools", async (t) => {
  const { home } = tempHome(); const f = fixture(); const script = [{ toolCalls: [{ name: "browser__pilot", args: { action: "prepare" } }] }, { toolCalls: [{ name: "browser__pilot", args: { action: "state" } }] }, { toolCalls: [{ name: "shell__run", args: { command: "must-never-run" } }] }, { text: "done" }];
  const sinty = new Sinty({ home, config: testConfig(script, {}, ["fake-provider"]), policy: policySchema.parse({ defaults: { external: "ask" } }), browserPilotDriver: f.driver }); await sinty.start();
  t.after(async () => { await sinty.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); await rm(f.dir, { recursive: true, force: true }); });
  const agent = saveAgent(sinty.paths, { name: "Actual" }), other = saveAgent(sinty.paths, { name: "Other" }); const project = saveProject(sinty.paths, { name: "Pilot", agentIds: [agent.id], leadId: agent.id }); ensureProjectDirs(sinty.paths, project);
  const s = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [other.id], agentId: other.id } });
  sinty.browserPilot.grant({ ownerId: "local-machine-owner", agentId: agent.id, sessionId: s.id, projectId: project.id, workspace: realpathSync(projectDir(sinty.paths, project)) }, "http://127.0.0.1:3180/browser-pilot-fixture");
  assert.throws(() => sinty.agent.send(s.id, "forged external dispatch", { agentId: other.id }), /owner browser pilot dispatch/);
  const turn = sinty.agent.sendPilot("local-machine-owner", s.id, "synthetic test only");
  const ctx = (sinty.agent as unknown as { toolCtx(a: string,b: string,c: string,d: string): any }).toolCtx(s.id, turn.turnId, "test", "test"); assert.equal(ctx.execution.agentId, agent.id); assert.equal(ctx.execution.projectId, project.id);
  await sinty.agent.idle(); const events = sinty.journal.events(s.id);
  assert.ok(events.some((e) => e.type === "tool.call.failed" && (e.data as any).code === "pilot_tool_denied"));
  assert.ok(events.some((e) => e.type === "tool.call.completed" && (e.data as any).blobs?.length === 1)); assert.ok(!JSON.stringify(events).includes(PNG));
  assert.equal(f.calls[0]?.args.profile.name, sinty.browserPilot.profile("local-machine-owner", agent.id, project.id));
});

test("browser pilot: junction in reserved download directory never reaches native driver", async (t) => {
  const f = fixture(); t.after(async () => { await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); });
  const outside = join(f.dir, "outside-download"); mkdirSync(outside); symlinkSync(outside, join(f.workspace, "_out"), "junction"); f.grant(); await f.broker.call(f.execution, { action: "prepare" });
  await assert.rejects(f.broker.call(f.execution, { action: "download", ref: "p1:1" }), /escaped/); assert.equal(f.calls.length, 1); assert.equal(existsSync(join(outside, "browser-pilot")), false);
});
test("browser pilot: expired lease and unconfirmed cleanup never grant fresh automation", async (t) => {
  const f = fixture(); t.after(async () => { f.driver.close = async () => true; await f.broker.stop(); await rm(f.dir, { recursive: true, force: true }); }); f.grant(); await f.broker.call(f.execution, { action: "prepare" });
  f.driver.close = async () => false; const status = await f.broker.release("owner", f.execution.sessionId) as any; assert.equal(status.mode, "quarantined"); await assert.rejects(f.broker.call(f.execution, { action: "state" }), /paused/);
  const lease = (f.broker as unknown as { leases: Map<string, { expires: number }> }).leases.get(f.execution.sessionId)!; lease.expires = Date.now() - 1;
  await assert.rejects(f.broker.call(f.execution, { action: "state" }), /expired/); assert.equal(f.calls.length, 1);
});
