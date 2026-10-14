import { z, type ToolSideEffects } from "@sinty/sdk";

export interface CoreToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  sideEffects: ToolSideEffects;
  idempotent: boolean;
}

/** Built into the core; plugins cannot register tools with these names. */
export const CORE_TOOLS: CoreToolDef[] = [
  {
    name: "ask_human",
    description: "Ask the human a question and wait for the answer. Use when a decision or missing information is needed.",
    input: z.object({ question: z.string().min(1) }),
    sideEffects: "none",
    idempotent: true,
  },
  {
    name: "context.recall",
    description: "Read exact earlier events of this session from the journal when the summary in context is not enough.",
    input: z.object({
      query: z.string().optional().describe("case-insensitive text to search for"),
      afterSeq: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    sideEffects: "read",
    idempotent: true,
  },
  {
    name: "plugin.list",
    description: "List installed plugins: version, where they live (bundled or home), whether you may patch them, their tools.",
    input: z.object({}),
    sideEffects: "read",
    idempotent: true,
  },
  {
    name: "plugin.read",
    description: "Read a plugin's source. Without path: list its files. Use before proposing a patch.",
    input: z.object({ plugin: z.string(), path: z.string().optional() }),
    sideEffects: "read",
    idempotent: true,
  },
  {
    name: "plugin.propose_patch",
    description:
      "Propose new full contents for files of a plugin. The core tests the patched copy in a sandbox (load check plus *.test.ts files) and returns a patchId. Nothing changes until plugin.apply_patch. Bundled plugins are forked to the home folder and run from src/*.ts; use .ts extensions in relative imports.",
    input: z.object({
      plugin: z.string(),
      reason: z.string().min(5).describe("what is wrong and how the patch fixes it"),
      files: z.array(z.object({ path: z.string().describe("relative to the plugin folder"), content: z.string() })).min(1).max(20),
    }),
    sideEffects: "write",
    idempotent: false,
  },
  {
    name: "plugin.apply_patch",
    description: "Apply a tested patch: commit, hot-reload the plugin, watch the next calls and roll back automatically if it breaks. Patches that change permissions always need human approval.",
    input: z.object({ patchId: z.string() }),
    sideEffects: "write",
    idempotent: false,
  },
];

export const CORE_TOOL_NAMES = new Set(CORE_TOOLS.map((t) => t.name));

export function coreToolSchema(t: CoreToolDef): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return rest;
}
