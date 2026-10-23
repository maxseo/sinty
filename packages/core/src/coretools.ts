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
    name: "memory.write",
    description: "Store one self-contained sentence. profile is always in the prompt (max 40). log is a dated event. note expires in 14 days. To correct a fact, forget the old one and write the new one. scope: user, agent, or chat.",
    input: z.object({
      text: z.string().min(1),
      tier: z.enum(["profile", "log", "note"]),
      scope: z.enum(["user", "agent", "chat"]),
      about: z.enum(["user", "work"]),
      source: z.string().min(1).default("agent"),
    }),
    sideEffects: "write",
    idempotent: true,
  },
  {
    name: "memory.forget",
    description: "Delete a fact by id or by its exact text.",
    input: z.object({ id: z.string().optional(), text: z.string().optional() }),
    sideEffects: "write",
    idempotent: true,
  },
  {
    name: "memory.recall",
    description: "Search journal and notes for this user, this agent and this chat. Returns up to 15 facts with date and tier. Profile is not searched.",
    input: z.object({
      query: z.string().min(1),
      embedding: z.array(z.number()).max(4096).optional(),
    }),
    sideEffects: "read",
    idempotent: true,
  },
  {
    name: "shell.run",
    description: "Run one command in the workspace. cwd is relative to the workspace. A human must approve it. Output is capped. Do not use it to read secrets or leave the workspace.",
    input: z.object({
      command: z.string().min(1),
      cwd: z.string().optional().describe("directory relative to the workspace, default ."),
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
    }),
    sideEffects: "external",
    idempotent: false,
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
    name: "agent.task",
    description:
      "Run a child turn with only the listed tools. Omit tools to allow web search, web read, memory recall and skill read. The child cannot start another child or use tools outside the list. Default: omit background (or false) and wait for the child in this parent turn. Set background: true only when the human asked to work in the background / keep chatting in parallel, or the task is long research and they need the parent free — never for a short factual answer. With background: true return {taskId,sessionId} immediately; when the child finishes the parent gets task.completed and a turn with trigger task if idle.",
    input: z.object({
      task: z.string().min(1),
      tools: z.array(z.string()).max(12).optional().describe("tool names the child may call (canonical web.search or wire web__search)"),
      background: z
        .boolean()
        .optional()
        .describe(
          "Default false/omit: wait for the child in this turn. true ONLY if the human asked for background/parallel chat, or long research while they keep talking. Never background a short answer.",
        ),
    }),
    sideEffects: "none",
    idempotent: false,
  },
  {
    name: "agent.task_steer",
    description: "Append a user message to a running child started by agent.task (by sessionId or taskId). Use to correct or narrow a background child without waiting for it to finish.",
    input: z.object({
      text: z.string().min(1),
      sessionId: z.string().optional().describe("child session id from agent.task"),
      taskId: z.string().optional().describe("task id from a background agent.task"),
    }),
    sideEffects: "none",
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

/**
 * Tool names that only one bundled plugin may register. web.* moved out of the core into tool-web and skill.* into
 * skills (plan step 7); keeping the names reserved means another plugin still cannot take over web.read, skill.read
 * and friends.
 */
export const RESERVED_TOOL_PREFIXES: Record<string, string> = { "web.": "tool-web", "skill.": "skills" };

/** The bundled plugin that owns this tool name, or undefined when any plugin may use it. */
export function reservedToolOwner(name: string): string | undefined {
  for (const [prefix, owner] of Object.entries(RESERVED_TOOL_PREFIXES)) if (name.startsWith(prefix)) return owner;
  return undefined;
}

export function coreToolSchema(t: CoreToolDef): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return rest;
}
