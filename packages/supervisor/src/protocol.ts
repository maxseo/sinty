import type { SintyEvent, ToolSideEffects } from "@sinty/sdk";

export interface SupervisorSettings {
  loopThreshold: number;
  maxNoticesPerTurn: number;
  maxNoticesPerDetector: number;
  docsMaxChars: number;
  budget: { steps?: number | undefined; tokens?: number | undefined };
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
  | { t: "event"; event: SintyEvent }
  | { t: "incident.stored"; incident: Incident }
  | { t: "checkpoint"; id: number; sessionId: string; turnId: string; phase: CheckpointPhase };

export type FromSupervisor =
  | { t: "ready" }
  | { t: "actions"; id: number; actions: SupervisorAction[] }
  | { t: "incident.resolved"; sessionId: string; turnId: string; incident: Omit<Incident, "id" | "createdAt"> }
  | { t: "log"; level: "info" | "warn" | "error"; msg: string };
