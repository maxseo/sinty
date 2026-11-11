/** Absolute path of a project file. A relative path is resolved from `root`, and a path that leaves `root` is refused. */
export declare function fileInRoot(root: string, file: string): string | undefined;
