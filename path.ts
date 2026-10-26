import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

// Resolve missing write/edit targets through their nearest existing ancestor.
// A dangling symlink is not a missing directory and must not bypass the boundary.
export async function resolveTarget(
  cwd: string,
  input: string,
  allowMissing: boolean,
) {
  const lexicalRoot = resolve(cwd);
  const expanded = input.startsWith("~/")
    ? resolve(homedir(), input.slice(2))
    : input;
  const lexicalTarget = resolve(lexicalRoot, expanded);
  const root = await realpath(lexicalRoot);
  if (!isWithin(lexicalRoot, lexicalTarget) && !isWithin(root, lexicalTarget))
    return;

  let current = lexicalTarget;
  for (;;) {
    try {
      const existing = await realpath(current);
      const file = resolve(existing, relative(current, lexicalTarget));
      if (!isWithin(root, existing) || !isWithin(root, file) || file === root)
        return;
      return { root, file };
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      try {
        // If lstat succeeds, realpath failed on an existing (dangling) symlink.
        await lstat(current);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

export function ancestorDirectories(root: string, file: string): string[] {
  const directories: string[] = [];
  for (
    let directory = dirname(file);
    directory !== root;
    directory = dirname(directory)
  ) {
    if (!isWithin(root, directory)) return [];
    directories.push(directory);
  }
  return directories.reverse();
}

export function projectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
