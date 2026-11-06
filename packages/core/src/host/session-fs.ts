import { isAbsolute, relative, resolve } from "node:path";

/** Manifest token for the current tool call's session root (`tool.workspace`), not the whole global desk. */
export const SESSION_GRANT = /^\$SESSION(\/[A-Za-z0-9_.\-/]*)?$/;

/** Largest file the host will copy across the session-fs IPC. */
export const SESSION_FS_MAX_BYTES = 50_000_000;

/** Grants that start with `$SESSION` and do not climb out of that tree. */
export function parseSessionGrants(entries: readonly string[] | undefined): string[] {
  return (entries ?? []).filter((p) => SESSION_GRANT.test(p) && !p.includes(".."));
}

/** Absolute path of `file` when it stays inside `root`. The root itself is allowed. */
export function fileInRoot(root: string, file: string): string | undefined {
  const abs = resolve(root, file);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return abs;
}

/**
 * Resolve `file` against the session workspace and the plugin's `$SESSION` grants.
 * `$SESSION` allows the whole session root; `$SESSION/_inbox` allows only that folder.
 */
export function resolveSessionPath(workspace: string, file: string, grants: readonly string[]): string | undefined {
  if (!workspace || !grants.length) return undefined;
  const abs = fileInRoot(workspace, file);
  if (!abs) return undefined;
  if (grants.includes("$SESSION")) return abs;
  for (const grant of grants) {
    if (!grant.startsWith("$SESSION/")) continue;
    const folder = resolve(workspace, grant.slice("$SESSION/".length));
    if (fileInRoot(folder, abs)) return abs;
  }
  return undefined;
}
