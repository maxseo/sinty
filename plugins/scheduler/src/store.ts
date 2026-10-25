import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextCronAfter } from "./cron.js";

export type JobKind = "cron" | "at";

export interface ScheduleJob {
  id: string;
  name: string;
  kind: JobKind;
  /** 5-field cron when kind=cron */
  cron?: string;
  /** ISO-8601 fire time when kind=at */
  at?: string;
  sessionId: string;
  /** User/agent text delivered on wake (message.user, channel=schedule). */
  text: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
}

interface FileShape {
  version: 1;
  jobs: ScheduleJob[];
}

export class JobStore {
  private readonly file: string;
  private data: FileShape;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "jobs.json");
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as FileShape)
      : { version: 1, jobs: [] };
    if (this.data.version !== 1 || !Array.isArray(this.data.jobs)) {
      this.data = { version: 1, jobs: [] };
    }
  }

  list(): ScheduleJob[] {
    return this.data.jobs.map((j) => ({ ...j }));
  }

  get(id: string): ScheduleJob | undefined {
    const j = this.data.jobs.find((x) => x.id === id);
    return j ? { ...j } : undefined;
  }

  upsert(job: ScheduleJob): void {
    const i = this.data.jobs.findIndex((x) => x.id === job.id);
    if (i >= 0) this.data.jobs[i] = job;
    else this.data.jobs.push(job);
    this.save();
  }

  remove(id: string): boolean {
    const before = this.data.jobs.length;
    this.data.jobs = this.data.jobs.filter((j) => j.id !== id);
    if (this.data.jobs.length === before) return false;
    this.save();
    return true;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

export function computeNext(job: Pick<ScheduleJob, "kind" | "cron" | "at" | "enabled">, from: Date = new Date()): string | null {
  if (!job.enabled) return null;
  if (job.kind === "at") {
    if (!job.at) return null;
    const t = new Date(job.at).getTime();
    if (Number.isNaN(t)) return null;
    return t > from.getTime() ? new Date(t).toISOString() : null;
  }
  if (!job.cron) return null;
  return nextCronAfter(job.cron, from).toISOString();
}

export function newJobId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `sch_${t}${r}`;
}
