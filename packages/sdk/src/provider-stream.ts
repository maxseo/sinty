import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { z } from "zod";
import { ToolError } from "./tool.js";
import type { ProviderChunk, ToolSchema } from "./plugin.js";

export interface ProviderToolCall { id: string; name: string; args: unknown }
const jsonObject = z.record(z.string(), z.json());
const identity = z.string().min(1).max(256);
const MAX_CALLS = 128;
export const MAX_TOOL_ARGUMENT_CHARS = 1_048_576;

/** Never include wire data or schema errors (which can contain private arguments) in this error. */
export class ProviderStreamError extends ToolError {
  constructor(reason: string, diagnostic?: string) {
    super("provider_protocol_error", "Invalid provider stream: " + reason, { ...(diagnostic ? { hint: diagnostic } : {}) });
  }
}

export function parseProviderJSON(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new ProviderStreamError("invalid_json"); }
}

export function parseToolArguments(raw: string): unknown {
  if (typeof raw !== "string" || raw.length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderStreamError("argument_limit");
  // Empty is not a completed JSON object. A no-argument call must send {}.
  return parseProviderJSON(raw);
}

// Cache compiled code by exact immutable schema bytes only; NEVER cache tools, arguments or authorization.
const schemaCache = new Map<string, ValidateFunction>();
let cachedSchemaChars = 0;
function compiledSchema(input: Record<string, unknown>): ValidateFunction {
  if (!jsonObject.safeParse(input).success) throw new Error("schema is not JSON");
  const key = JSON.stringify(input);
  const hit = schemaCache.get(key);
  if (hit) { schemaCache.delete(key); schemaCache.set(key, hit); return hit; }
  const schema = JSON.parse(key) as Record<string, unknown>;
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const legacyTuple = key.includes('"items":[');
  const Constructor = dialect.includes("draft-07") || (!dialect && legacyTuple) ? Ajv : dialect.includes("2019-09") ? Ajv2019 : Ajv2020;
  const ajv = new Constructor({ strictSchema: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, logger: false, useDefaults: false, coerceTypes: false, removeAdditional: false, allErrors: false });
  for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
  const validator = ajv.compile(schema);
  if ("$async" in validator && validator.$async === true) throw new Error("async schema not supported");
  if (key.length <= 131_072) {
    while (schemaCache.size >= 64 || cachedSchemaChars + key.length > 1_048_576) {
      const oldest = schemaCache.keys().next().value!;
      cachedSchemaChars -= oldest.length; schemaCache.delete(oldest);
    }
    schemaCache.set(key, validator); cachedSchemaChars += key.length;
  }
  return validator;
}

/** Validate the complete batch, against THIS request's exact wire catalog, before exposing any call. */
export function validateProviderCalls(calls: readonly ProviderToolCall[], tools: readonly ToolSchema[], reservedIds: Iterable<string> = []): void {
  if (calls.length > MAX_CALLS) throw new ProviderStreamError("call_limit");
  const ids = new Set(reservedIds);
  const catalog = new Map<string, ToolSchema>();
  for (const tool of tools) {
    if (catalog.has(tool.name)) throw new ProviderStreamError("ambiguous_catalog");
    catalog.set(tool.name, tool);
  }
  const compiled = new Map<string, ValidateFunction>();
  for (const call of calls) {
    if (!identity.safeParse(call.id).success || !identity.safeParse(call.name).success) throw new ProviderStreamError("invalid_identity");
    if (ids.has(call.id)) throw new ProviderStreamError("duplicate_call_id");
    ids.add(call.id);
    const tool = catalog.get(call.name);
    if (!tool) throw new ProviderStreamError("unadvertised_tool");
    if (!jsonObject.safeParse(call.args).success) throw new ProviderStreamError("arguments_not_json_object");
    if (Object.hasOwn(call.args as object, "__invalid_json")) throw new ProviderStreamError("invalid_arguments");
    if (JSON.stringify(call.args).length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderStreamError("argument_limit");
    let valid: boolean;
    try {
      let validator = compiled.get(call.name);
      if (!validator) {
        validator = compiledSchema(tool.inputSchema);
        compiled.set(call.name, validator);
      }
      valid = validator(call.args) === true;
    }
    catch { throw new ProviderStreamError("unsupported_argument_schema"); }
    if (!valid) throw new ProviderStreamError("invalid_arguments");
  }
}

export function toolTerminal(stopReason: string): boolean { return stopReason === "tool_calls" || stopReason === "tool_use"; }

/** Opt-in bounded metadata ONLY. No names, IDs, payloads, endpoints, prompts, errors or credentials. */
export class StreamDiagnostics {
  private frames = 0;
  private terminal = false;
  private readonly rows = new Map<number, { index: number; idLength: number; nameLength: number; argumentLength: number; updates: number; repeatedMetadata: number }>();
  constructor(private readonly enabled: boolean) {}
  frame(): void { this.frames = Math.min(this.frames + 1, 1_000_000); }
  end(): void { this.terminal = true; }
  call(index: number, id: string, name: string, args: string, repeated = false): void {
    if (!this.enabled || (!this.rows.has(index) && this.rows.size >= 16)) return;
    const row = this.rows.get(index) ?? { index, idLength: 0, nameLength: 0, argumentLength: 0, updates: 0, repeatedMetadata: 0 };
    row.idLength = Math.min(id.length, 1_000_000); row.nameLength = Math.min(name.length, 1_000_000);
    row.argumentLength = Math.min(args.length, 1_000_000); row.updates = Math.min(row.updates + 1, 1_000_000);
    if (repeated) row.repeatedMetadata = Math.min(row.repeatedMetadata + 1, 1_000_000);
    this.rows.set(index, row);
  }
  error(reason: string): ProviderStreamError {
    return new ProviderStreamError(reason, this.enabled ? JSON.stringify({ version: 1, frames: this.frames, terminal: this.terminal, choice: 0, calls: [...this.rows.values()] }) : undefined);
  }
}

const count = z.number().int().min(0).max(1_000_000);
const diagnosticSchema = z.strictObject({
  version: z.literal(1), frames: count, terminal: z.boolean(), choice: z.literal(0),
  calls: z.array(z.strictObject({ index: z.number().int().min(0).max(127), idLength: count, nameLength: count, argumentLength: count, updates: count, repeatedMetadata: count })).max(16),
});
export type StreamDiagnostic = z.infer<typeof diagnosticSchema>;
/** Sanitize even diagnostics returned by an untrusted provider plugin. Never journal an opaque hint. */
export function readStreamDiagnostic(hint: unknown): StreamDiagnostic | undefined {
  if (typeof hint !== "string" || hint.length > 4096) return undefined;
  try { const parsed = diagnosticSchema.safeParse(JSON.parse(hint)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}

const usageCount = z.number().int().nonnegative().finite();
const providerChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("reasoning"), text: z.string() }),
  z.strictObject({ type: z.literal("tool_call"), id: identity, name: identity, args: jsonObject }),
  z.strictObject({ type: z.literal("done"), stopReason: z.string().min(1).max(64), usage: z.strictObject({ inputTokens: usageCount, outputTokens: usageCount, cachedTokens: usageCount.optional(), cacheMissTokens: usageCount.optional(), cacheWriteTokens: usageCount.optional() }) }),
]);
export function validateProviderChunk(chunk: unknown): asserts chunk is ProviderChunk {
  if (!providerChunkSchema.safeParse(chunk).success) throw new ProviderStreamError("invalid_chunk");
}
