import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { ancestorDirectories, isWithin, resolveTarget } from "./path.ts";
import type { Instruction } from "./registry.ts";

export interface Discovery {
  root: string;
  file: string;
  directories: string[];
  instructions: Instruction[];
}

export async function discover(
  cwd: string,
  input: string,
  allowMissing: boolean,
  cached: ReadonlyMap<string, Instruction>,
): Promise<Discovery | undefined> {
  const target = await resolveTarget(cwd, input, allowMissing);
  if (!target) return;
  const directories = ancestorDirectories(target.root, target.file);
  const instructions: Instruction[] = [];
  for (const directory of directories) {
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
  return { ...target, directories, instructions };
}
