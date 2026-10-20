import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SintyEvent } from "@sinty/sdk";
import type { CheckpointPhase, FromSupervisor, Incident, SupervisedTool, SupervisorAction, SupervisorSettings, ToSupervisor } from "@sinty/supervisor";
import type { SintyPaths } from "./paths.js";

const CHECKPOINT_TIMEOUT_MS = 3000;

export interface SupervisorHooks {
  log(level: string, msg: string): void;
  incidentResolved(sessionId: string, turnId: string, incident: Omit<Incident, "id" | "createdAt">): void;
  /** Events of turns that are still open, replayed after a (re)start so the supervisor has their history. */
  replay(): SintyEvent[];
}

/** Runs the supervisor as a read-only child process. The core keeps working if it is down. */
export class SupervisorClient {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly waiting = new Map<number, (a: SupervisorAction[]) => void>();
  private stopping = false;
  private restarts = 0;
  private tools: SupervisedTool[] = [];

  constructor(
    private readonly paths: SintyPaths,
    private settings: SupervisorSettings,
    private readonly incidents: () => Incident[],
    private readonly hooks: SupervisorHooks,
  ) {}

  async start(): Promise<void> {
    const main = join(this.paths.install, "packages", "supervisor", "dist", "main.js");
    if (!existsSync(main)) {
      this.hooks.log("warn", `supervisor not found at ${main}; running without it`);
      return;
    }
    const child = fork(main, [], {
      execArgv: ["--permission", `--allow-fs-read=${this.paths.install}`, `--allow-fs-read=${this.paths.plugins}`, "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.child = child;
    child.stderr?.on("data", (b: Buffer) => this.hooks.log("warn", `[supervisor] ${b.toString().trimEnd()}`));
    child.on("message", (m: FromSupervisor) => this.onMessage(m));
    child.on("exit", (code) => this.onExit(code));
    const ready = new Promise<void>((resolve) => {
      const onMsg = (m: FromSupervisor): void => {
        if (m.t === "ready") {
          child.off("message", onMsg);
          resolve();
        }
      };
      child.on("message", onMsg);
      setTimeout(resolve, 5000).unref();
    });
    this.send({ t: "init", settings: this.settings, tools: this.tools, incidents: this.incidents() });
    await ready;
    for (const event of this.hooks.replay()) this.send({ t: "event", event });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }

  /** New limits from the settings page; the child applies them from its next checkpoint (and gets them again on restart). */
  setSettings(settings: SupervisorSettings): void {
    this.settings = settings;
    this.send({ t: "settings", settings });
  }

  setTools(tools: SupervisedTool[]): void {
    this.tools = tools;
    this.send({ t: "tools", tools });
  }

  event(event: SintyEvent): void {
    this.send({ t: "event", event });
  }

  incidentStored(incident: Incident): void {
    this.send({ t: "incident.stored", incident });
  }

  checkpoint(sessionId: string, turnId: string, phase: CheckpointPhase): Promise<SupervisorAction[]> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve([]);
      }, CHECKPOINT_TIMEOUT_MS);
      this.waiting.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      if (!this.send({ t: "checkpoint", id, sessionId, turnId, phase })) {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve([]);
      }
    });
  }

  private send(msg: ToSupervisor): boolean {
    if (!this.child?.connected) return false;
    this.child.send(msg);
    return true;
  }

  private onMessage(m: FromSupervisor): void {
    if (this.stopping) return;
    if (m.t === "actions") {
      this.waiting.get(m.id)?.(m.actions);
      this.waiting.delete(m.id);
    } else if (m.t === "incident.resolved") {
      this.hooks.incidentResolved(m.sessionId, m.turnId, m.incident);
    } else if (m.t === "log") {
      this.hooks.log(m.level, `[supervisor] ${m.msg}`);
    }
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    for (const resolve of this.waiting.values()) resolve([]);
    this.waiting.clear();
    if (this.stopping) return;
    this.restarts++;
    this.hooks.log("warn", `supervisor exited with ${code}; restart #${this.restarts}`);
    setTimeout(
      () => {
        if (!this.stopping) void this.start();
      },
      Math.min(30_000, 500 * 2 ** Math.min(this.restarts, 6)),
    ).unref();
  }
}
