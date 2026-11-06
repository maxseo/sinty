import { isAbsolute, relative, resolve } from "node:path";

/** Absolute path of `file` when it stays inside `root`. */
export function fileInRoot(root: string, file: string): string | undefined {
  const abs = resolve(root, file);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return abs;
}
