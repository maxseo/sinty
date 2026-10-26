import { isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError } from "@sinty/sdk";

/** Resolve a tool path against the effective workspace (session project dir or global) or skills:. */
export function resolveImagePath(
  p: string,
  roots: { workspace: string; skills: string },
): { abs: string; shown: string } {
  const [root, rel] = p.startsWith("skills:") ? [roots.skills, p.slice(7)] : [roots.workspace, p];
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const inside = [roots.workspace, roots.skills].some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep));
  if (!inside) {
    throw new ToolError("outside_workspace", `${p} is outside the workspace and skills folders`, {
      hint: "Use a path relative to the workspace, or skills:<name>/file.png.",
    });
  }
  const base =
    abs === roots.skills || abs.startsWith(roots.skills.endsWith(sep) ? roots.skills : roots.skills + sep)
      ? roots.skills
      : roots.workspace;
  return { abs, shown: (base === roots.skills ? "skills:" : "") + (relative(base, abs).split(sep).join("/") || ".") };
}
