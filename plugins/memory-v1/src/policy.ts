export type Home = "chat" | "project" | "user";
export type CardType = "person" | "preference" | "fact" | "decision" | "question";
/** `near` is eligible for the prompt index. `long` is found by search. */
export type Span = "near" | "long";
export type CardStatus = "current" | "past" | "reverted" | "open" | "answered" | "dropped";
export type Mode = "chat" | "project" | "agent";

export interface Policy {
  /** chat: only this chat, plus the user card when aboutUser is on. project: this project. agent: every project this agent has, if otherProjects is on. */
  mode: Mode;
  /** Person and preference cards travel across chats and projects. */
  aboutUser: boolean;
  /** Decisions and questions of this project. */
  projectWork: boolean;
  /** Project facts, decisions and questions from other projects. Requires mode "agent". */
  otherProjects: boolean;
  /** Once a day, reread today's cards and write a day note. */
  night: boolean;
  /** Add the research hint to that night pass. */
  researchAtNight: boolean;
  /** Plain-language rules for the night pass. Empty means no extra hint. */
  researchPrompt: string;
}

export const DEFAULT_POLICY: Policy = { mode: "project", aboutUser: true, projectWork: true, otherProjects: false, night: false, researchAtNight: false, researchPrompt: "" };

export interface ClaimView {
  id: string;
  userId: string;
  agentId: string;
  sessionId: string;
  projectId: string;
  home: Home;
  kind: CardType;
  span: Span;
  status: CardStatus;
  subject: string;
  text: string;
  salience: number;
  validTo: string | null;
  touchedAt: string;
  basis?: string;
  validFrom?: string;
  quote?: string;
}

const PAST = new Set<CardStatus>(["past", "reverted", "answered", "dropped"]);

export function spanFor(kind: CardType): Span {
  return kind === "decision" || kind === "question" ? "long" : "near";
}

export function homeFor(kind: CardType, projectId: string | undefined): Home {
  if (kind === "person" || kind === "preference") return "user";
  if (kind === "fact") return projectId ? "project" : "user";
  return projectId ? "project" : "chat";
}

export function freshStatus(kind: CardType): CardStatus {
  return kind === "question" ? "open" : "current";
}

export function isPast(status: CardStatus): boolean {
  return PAST.has(status);
}

export function brightness(salience: number, touchedAt: string, now = Date.now()): number {
  const days = Math.max(0, (now - Date.parse(touchedAt)) / 86_400_000);
  return Math.max(0, Math.min(1, salience * Math.pow(0.98, days)));
}

/** Whether this chat may see the card. History cards need wantsHistory. */
export function inRecall(claim: ClaimView, here: { sessionId: string; projectId?: string }, policy: Policy, wantsHistory = false, now = Date.now()): boolean {
  if (isPast(claim.status)) return wantsHistory;
  if (claim.validTo) return wantsHistory;
  if (brightness(claim.salience, claim.touchedAt, now) < 0.15) return false;
  if (claim.home === "user") return policy.aboutUser || claim.sessionId === here.sessionId;
  if (claim.sessionId === here.sessionId) return true;
  if (policy.mode === "chat") return false;
  const sameProject = Boolean(here.projectId) && claim.projectId === here.projectId;
  if (sameProject && (claim.kind === "decision" || claim.kind === "question")) return policy.projectWork;
  if (sameProject && claim.home === "project") return true;
  if (policy.mode === "agent" && policy.otherProjects && claim.home === "project") return true;
  return false;
}

export function wantsHistory(query: string): boolean {
  return /(раньше|прежде|было|бывало|used to|\bbefore\b)/i.test(query);
}
