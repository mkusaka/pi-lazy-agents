import { constants, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { ancestorDirectories, isWithin, resolveTarget } from "./path.ts";
import type { Instruction } from "./registry.ts";

export interface Discovery {
  root: string;
  file: string;
  directories: string[];
  instructions: Instruction[];
  skills: Map<string, Skill[]>;
}

// Mirrors pi's ancestor .agents/skills loading for descendant directories.
// ponytail: loadSkillsFromDir uses pi's ".pi/skills" walk, so root-level .md files are
// filtered out here, but nested .md files without SKILL.md are not loaded as pi's
// ".agents" walk would; reimplement that walk if such layouts matter.
function discoverSkills(root: string, directory: string): Skill[] {
  let dir: string;
  try {
    dir = realpathSync(join(directory, ".agents", "skills"));
  } catch {
    return [];
  }
  // pi itself loads cwd/.agents/skills; never reload it via an alias.
  if (!isWithin(root, dir) || dir === join(root, ".agents", "skills"))
    return [];
  // Diagnostics contain absolute paths and raw errors; never surface them.
  return loadSkillsFromDir({ dir, source: "project" }).skills.filter(
    (skill) =>
      (dirname(skill.filePath) !== dir ||
        basename(skill.filePath) === "SKILL.md") &&
      within(root, skill.filePath),
  );
}

function within(root: string, path: string): boolean {
  try {
    return isWithin(root, realpathSync(path));
  } catch {
    return false;
  }
}

export async function discover(
  cwd: string,
  input: string,
  allowMissing: boolean,
  cached: ReadonlyMap<string, Instruction>,
  trusted = false,
): Promise<Discovery | undefined> {
  const target = await resolveTarget(cwd, input, allowMissing);
  if (!target) return;
  const directories = ancestorDirectories(target.root, target.file);
  const instructions: Instruction[] = [];
  const skills = new Map<string, Skill[]>();
  for (const directory of directories) {
    // Like pi, project skills load only when the project is trusted.
    const found = trusted ? discoverSkills(target.root, directory) : [];
    if (found.length > 0) skills.set(directory, found);
    try {
      const path = await realpath(join(directory, "AGENTS.md"));
      // Never read outside the boundary or reload a root context file via an alias.
      if (!isWithin(target.root, path) || dirname(path) === target.root)
        continue;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          console.warn("[lazy-agents] Skipped instructions (not-a-file).");
          continue;
        }
        if (metadata.size > config.maxFileSizeBytes) {
          console.warn("[lazy-agents] Skipped instructions (too-large).");
          continue;
        }
        const previous = cached.get(path);
        if (
          previous &&
          previous.mtimeMs === metadata.mtimeMs &&
          previous.size === metadata.size
        ) {
          instructions.push({ ...previous, directory });
          continue;
        }
        // Bound the read even if the file grows after stat(). Never inject a prefix.
        const buffer = Buffer.alloc(config.maxFileSizeBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            size,
            buffer.length - size,
            null,
          );
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > config.maxFileSizeBytes) {
          console.warn("[lazy-agents] Skipped instructions (too-large).");
          continue;
        }
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, size),
          );
        } catch {
          console.warn("[lazy-agents] Skipped instructions (invalid-utf8).");
          continue;
        }
        instructions.push({
          path,
          directory,
          content: content.replace(/\r\n?/g, "\n"),
          mtimeMs: metadata.mtimeMs,
          size,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        console.warn("[lazy-agents] Skipped instructions (unreadable).");
      }
    }
  }
  return { ...target, directories, instructions, skills };
}
