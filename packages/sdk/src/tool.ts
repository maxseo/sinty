import type { z } from "zod";
import type { BlobRef, ToolSideEffects } from "./events.js";

export type PolicyDecision = "allow" | "ask" | "deny";

export interface ToolRunContext {
  sessionId: string;
  turnId: string;
  callId: string;
  /** Stable for the same step across retries and resume. */
  idempotencyKey: string;
  signal: AbortSignal;
  progress(update: { message?: string; ratio?: number }): void;
}

export interface ToolResult {
  content: unknown;
  blobs?: BlobRef[];
}

/** Answer of `recover()`: what really happened to a call interrupted by a crash. */
export type RecoverOutcome =
  | { status: "completed"; result: ToolResult }
  | { status: "running"; resumeToken?: string }
  | { status: "not_started" }
  | { status: "unknown" };

export interface ToolDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  sideEffects: ToolSideEffects;
  idempotent?: boolean;
  timeoutMs?: number;
  docs?: string;
  run(args: z.infer<I>, ctx: ToolRunContext): Promise<ToolResult>;
  recover?(idempotencyKey: string, ctx: Omit<ToolRunContext, "progress">): Promise<RecoverOutcome>;
}

/** Throw from a tool to give the model and the supervisor a code and a hint. */
export class ToolError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { hint?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }
}
