import { definePlugin, ToolError, z, type SystemSectionInput } from "@sinty/sdk";
import { readSettings } from "./settings.ts";
import { editSkillFile, importSkill, listSkillFiles, listSkills, readSkill, readSkillFile, skillCatalog, writeSkill, writeSkillFile, type SkillInfo } from "./skills.ts";

/**
 * Skills, moved out of the core (plan step 7). The skill.* tools keep the names, descriptions, input schemas, error
 * codes and hints the core had, so policies (`"skill.*": allow`), approvals, the supervisor, agent.task's default
 * tool list and old journals keep working. The catalog is a system section: it sits right after the system prompt,
 * in the static zone of the prompt, byte for byte what the core used to put there.
 */

const FILE_HINT = "Paths stay inside the skill folder. skill.edit needs a fragment that appears once.";
const READ_HINT = "Use a name from the skills list.";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The skills this speaker may follow: all of them outside projects, the ticked ones on a roster agent's card. */
export function visibleSkills(all: SkillInfo[], input: SystemSectionInput): SkillInfo[] {
  const agent = input.agent;
  return agent ? all.filter((s) => agent.skills.includes(s.name)) : all;
}

export default definePlugin({
  name: "skills",
  setup(ctx) {
    const root = ctx.paths.skills;
    const s = readSettings(ctx.config);

    ctx.systemSection("catalog", (input) => skillCatalog(visibleSkills(listSkills(root), input), s.catalogLimit), { order: 0, kind: "skills" });

    // The agent card's skills tab; /v1/roster/skills forwards here.
    ctx.http({
      method: "GET",
      path: "/list",
      handler: () => Response.json({ skills: listSkills(root).map((x) => ({ name: x.name, description: x.description })) }),
    });

    ctx.http({
      method: "GET",
      path: "/item",
      handler: (req) => {
        const name = new URL(req.url).searchParams.get("name") ?? "";
        try {
          const skill = readSkill(root, name);
          const files = listSkillFiles(root, name).files;
          return Response.json({ ...skill, description: listSkills(root).find((s) => s.name === name)?.description ?? "", files });
        } catch (e) {
          return Response.json({ error: { message: message(e) } }, { status: 404 });
        }
      },
    });

    ctx.http({
      method: "GET",
      path: "/file",
      handler: (req) => {
        const url = new URL(req.url);
        try {
          return Response.json(readSkillFile(root, url.searchParams.get("name") ?? "", url.searchParams.get("path") ?? ""));
        } catch (e) {
          return Response.json({ error: { message: message(e) } }, { status: 404 });
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/import",
      async handler(req) {
        const body = (await req.json().catch(() => null)) as { name?: unknown; text?: unknown; files?: { path?: unknown; text?: unknown }[] } | null;
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const files = Array.isArray(body?.files)
          ? body.files.flatMap((f) => (typeof f.path === "string" && typeof f.text === "string" ? [{ path: f.path, text: f.text }] : []))
          : [];
        if (typeof body?.text === "string" && body.text.trim()) files.unshift({ path: "SKILL.md", text: body.text });
        try {
          return Response.json(importSkill(root, name, files), { status: 201 });
        } catch (e) {
          return Response.json({ error: { message: message(e) } }, { status: 400 });
        }
      },
    });

    ctx.tool({
      name: "skill.files",
      description: "List files inside one skill folder: scripts, instructions and SKILL.md.",
      input: z.object({ name: z.string().min(1) }),
      sideEffects: "read",
      idempotent: true,
      async run({ name }) {
        try {
          return { content: listSkillFiles(root, name) };
        } catch (e) {
          throw new ToolError("not_found", message(e), { hint: FILE_HINT });
        }
      },
    });

    ctx.tool({
      name: "skill.read_file",
      description: "Read one text file inside a skill. path is relative to the skill folder, for example scripts/boil.js or SKILL.md.",
      input: z.object({ name: z.string().min(1), path: z.string().min(1) }),
      sideEffects: "read",
      idempotent: true,
      async run({ name, path }) {
        try {
          return { content: readSkillFile(root, name, path) };
        } catch (e) {
          throw new ToolError("not_found", message(e), { hint: FILE_HINT });
        }
      },
    });

    ctx.tool({
      name: "skill.write_file",
      description: "Create or replace one text file inside a skill: a script, an extra instruction, or SKILL.md. path is relative to the skill folder.",
      input: z.object({ name: z.string().min(1), path: z.string().min(1), text: z.string().min(1) }),
      sideEffects: "write",
      idempotent: true,
      async run({ name, path, text }) {
        try {
          return { content: writeSkillFile(root, name, path, text) };
        } catch (e) {
          throw new ToolError("invalid_args", message(e), { hint: FILE_HINT });
        }
      },
    });

    ctx.tool({
      name: "skill.edit",
      description: "Replace one unique fragment in a file inside a skill. Read the file first and pass the exact old text. Use this to patch SKILL.md or a script without rewriting the whole file.",
      input: z.object({ name: z.string().min(1), path: z.string().min(1), old: z.string().min(1), replacement: z.string() }),
      sideEffects: "write",
      idempotent: false,
      async run({ name, path, old, replacement }) {
        try {
          return { content: editSkillFile(root, name, path, old, replacement) };
        } catch (e) {
          throw new ToolError("invalid_args", message(e), { hint: FILE_HINT });
        }
      },
    });

    ctx.tool({
      name: "skill.write",
      description: "Create or replace skills/<name>/SKILL.md. The name is the folder. Put a description line in the frontmatter so the next turn can list it.",
      input: z.object({
        name: z.string().min(1),
        text: z.string().min(1).describe("full SKILL.md, including frontmatter"),
      }),
      sideEffects: "write",
      idempotent: true,
      async run({ name, text }) {
        try {
          return { content: writeSkill(root, name, text) };
        } catch (e) {
          throw new ToolError("invalid_args", message(e));
        }
      },
    });

    ctx.tool({
      name: "skill.read",
      description: "Read one skill's SKILL.md from the skills folder. Use the name from the skills list in the prompt.",
      input: z.object({ name: z.string().min(1) }),
      sideEffects: "read",
      idempotent: true,
      async run({ name }) {
        try {
          return { content: readSkill(root, name) };
        } catch (e) {
          throw new ToolError("not_found", message(e), { hint: READ_HINT });
        }
      },
    });
  },
});
