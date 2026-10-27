import type { Skill } from "@earendil-works/pi-coding-agent";
import type { Discovery } from "./discovery.ts";

export interface Instruction {
  path: string;
  directory: string;
  content: string;
  mtimeMs: number;
  size: number;
}

export class Registry {
  instructions = new Map<string, Instruction>();
  skills = new Map<string, Skill[]>();
  visitedFiles = new Set<string>();
  root = "";

  apply(discovery: Discovery): void {
    this.root = discovery.root;
    const directories = new Set(discovery.directories);
    for (const [path, instruction] of this.instructions) {
      if (directories.has(instruction.directory))
        this.instructions.delete(path);
    }
    for (const directory of directories) this.skills.delete(directory);
    for (const [directory, skills] of discovery.skills)
      this.skills.set(directory, skills);
    for (const instruction of discovery.instructions) {
      this.instructions.set(instruction.path, instruction);
    }
    this.visitedFiles.add(discovery.file);
  }
}
