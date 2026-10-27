import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { projectPath } from "./path.ts";
import type { Registry } from "./registry.ts";

const customType = "pi-lazy-agents.directory-instructions";

function attribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export function inject(
  messages: ContextEvent["messages"],
  registry: Registry,
): ContextEvent["messages"] {
  const result = messages.filter(
    (message) => message.role !== "custom" || message.customType !== customType,
  );
  const depth = (directory: string) =>
    projectPath(registry.root, directory).split("/").length;
  const instructions = [...registry.instructions.values()].sort((a, b) => {
    const left = projectPath(registry.root, a.directory);
    const right = projectPath(registry.root, b.directory);
    return (
      left.split("/").length - right.split("/").length ||
      left.localeCompare(right) ||
      a.path.localeCompare(b.path)
    );
  });
  const sections = instructions.map((instruction) => {
    const path = attribute(projectPath(registry.root, instruction.path));
    const scope = attribute(
      `${projectPath(registry.root, instruction.directory)}/**`,
    );
    return `<instruction path="${path}" scope="${scope}">\n${instruction.content}\n</instruction>`;
  });
  // Same listing pi puts in the system prompt, with cwd-relative locations.
  const skills = formatSkillsForPrompt(
    [...registry.skills.entries()]
      .sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))
      .flatMap(([, skills]) => skills)
      .map((skill) => ({
        ...skill,
        filePath: projectPath(registry.root, skill.filePath),
      })),
  ).trim();
  if (sections.length === 0 && !skills) return result;
  const parts: string[] = [];
  if (sections.length > 0)
    parts.push(`The following project instructions were loaded from directories accessed during this session.
Each instruction applies only to files within its declared scope.

${sections.join("\n\n")}

More specific directory instructions take precedence within their scope.`);
  if (skills)
    parts.push(
      `The following project skills were loaded from .agents/skills directories accessed during this session.\n${skills}`,
    );
  result.push({
    role: "custom",
    customType,
    display: false,
    timestamp: Date.now(),
    content: `<system-reminder type="directory-instructions">
${parts.join("\n\n")}
</system-reminder>`,
  });
  return result;
}
