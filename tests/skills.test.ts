import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { discover } from "../discovery.ts";
import { inject } from "../injection.ts";
import { Registry } from "../registry.ts";

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Use for ${name}.\n${extra}---\nSecret body of ${name}\n`;

test("descendant .agents/skills follow pi's trust and layout rules and inject descriptions only", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  for (const [path, content] of [
    [".agents/skills/root/SKILL.md", skill("root")],
    ["src/.agents/skills/nested/SKILL.md", skill("nested")],
    [
      "src/.agents/skills/hidden/SKILL.md",
      skill("hidden", "disable-model-invocation: true\n"),
    ],
    ["src/.agents/skills/loose.md", skill("loose")],
    ["src/x.ts", "export {};"],
  ]) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  assert.equal(
    (await discover(root, "src/x.ts", false, new Map()))?.skills.size,
    0,
  );
  const result = await discover(root, "src/x.ts", false, new Map(), true);
  assert.deepEqual(
    result?.skills
      .get(join(root, "src"))
      ?.map((item) => item.name)
      .sort(),
    ["hidden", "nested"],
  );
  const registry = new Registry();
  registry.apply(result!);
  const reminder = inject([], registry).at(-1);
  assert.ok(reminder?.role === "custom");
  const text = String(reminder.content);
  assert.match(text, /<name>nested<\/name>/);
  assert.match(
    text,
    /<location>src\/\.agents\/skills\/nested\/SKILL\.md<\/location>/,
  );
  assert.doesNotMatch(
    text,
    /hidden|loose|root|Secret body|project instructions/,
  );

  await rm(join(root, "src/.agents"), { recursive: true });
  registry.apply((await discover(root, "src/x.ts", false, new Map(), true))!);
  assert.deepEqual(inject([], registry), []);
});
