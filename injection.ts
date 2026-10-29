import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { projectPath } from "./path.ts";
import type { Registry } from "./registry.ts";

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

// Renders registry entries not yet in `sent` and records them there.
export function reminder(
  registry: Registry,
  sent: Set<string>,
): string | undefined {
  const depth = (directory: string) =>
    projectPath(registry.root, directory).split("/").length;
  const instructions = [...registry.instructions.values()]
    .filter((instruction) => {
      const key = `${instruction.path}\0${instruction.mtimeMs}\0${instruction.size}`;
      if (sent.has(key)) return false;
      sent.add(key);
      return true;
    })
    .sort((a, b) => {
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
      .filter((skill) => {
        if (sent.has(skill.filePath)) return false;
        sent.add(skill.filePath);
        return true;
      })
      .map((skill) => ({
        ...skill,
        filePath: projectPath(registry.root, skill.filePath),
      })),
  ).trim();
  if (sections.length === 0 && !skills) return;
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
  return `<system-reminder type="directory-instructions">
${parts.join("\n\n")}
</system-reminder>`;
}
