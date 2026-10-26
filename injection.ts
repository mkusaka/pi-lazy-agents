import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { projectPath } from "./path.ts";
import type { Registry } from "./registry.ts";

const customType = "pi-lazy-agents.directory-instructions";

function attribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

export function inject(messages: ContextEvent["messages"], registry: Registry): ContextEvent["messages"] {
  const result = messages.filter((message) => message.role !== "custom" || message.customType !== customType);
  if (registry.instructions.size === 0) return result;
  const instructions = [...registry.instructions.values()].sort((a, b) => {
    const left = projectPath(registry.root, a.directory);
    const right = projectPath(registry.root, b.directory);
    return left.split("/").length - right.split("/").length || left.localeCompare(right) || a.path.localeCompare(b.path);
  });
  const sections = instructions.map((instruction) => {
    const path = attribute(projectPath(registry.root, instruction.path));
    const scope = attribute(`${projectPath(registry.root, instruction.directory)}/**`);
    return `<instruction path="${path}" scope="${scope}">\n${instruction.content}\n</instruction>`;
  });
  result.push({
    role: "custom",
    customType,
    display: false,
    timestamp: Date.now(),
    content: `<system-reminder type="directory-instructions">
The following project instructions were loaded from directories accessed during this session.
Each instruction applies only to files within its declared scope.

${sections.join("\n\n")}

More specific directory instructions take precedence within their scope.
</system-reminder>`,
  });
  return result;
}
