import { isAbsolute, relative, resolve } from "node:path";
/** Absolute path of a project file. A relative path is resolved from `root`, and a path that leaves `root` is refused. */
export function fileInRoot(root, file) {
    const abs = resolve(root, file);
    const rel = relative(resolve(root), abs);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel)))
        return undefined;
    return abs;
}
//# sourceMappingURL=files.js.map