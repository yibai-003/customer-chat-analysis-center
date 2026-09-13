import fs from "node:fs";
import path from "node:path";

/** Reject symlinks and Windows junctions in every existing path component. */
export function assertNoLinks(file: string) {
  let current = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`不允许符号链接或目录联接：${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function inside(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
