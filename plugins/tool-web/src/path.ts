import { isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError } from "@sinty/sdk";

/**
 * Resolve a download destination under the effective workspace (session project dir or global).
 * Rejects skills: and any path that escapes the workspace root (same chroot rules as tool-fs).
 */
export function resolveDestPath(p: string, workspace: string): { abs: string; shown: string } {
  if (p.startsWith("skills:")) {
    throw new ToolError("outside_workspace", "web.fetch_file cannot write into skills:", {
      hint: "Use a path relative to the workspace (e.g. _out/doc.pdf).",
    });
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspace, p);
  const root = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (abs !== workspace && !abs.startsWith(root)) {
    throw new ToolError("outside_workspace", `${p} is outside the workspace`, {
      hint: "Use a path relative to the workspace.",
    });
  }
  return { abs, shown: relative(workspace, abs).split(sep).join("/") || "." };
}
