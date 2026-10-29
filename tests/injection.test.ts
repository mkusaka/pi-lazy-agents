import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reminder } from "../injection.ts";
import { Registry } from "../registry.ts";

test("reminders list only unsent instructions, parent first, with relative scopes", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const registry = new Registry();
  registry.root = root;
  const add = (directory: string) => {
    const path = join(root, directory, "AGENTS.md");
    registry.instructions.set(path, {
      path,
      directory: join(root, directory),
      content: `Rules for ${directory}`,
      mtimeMs: 1,
      size: 1,
    });
  };
  for (const directory of ["src/deep", "src"]) add(directory);
  const sent = new Set<string>();
  const text = reminder(registry, sent)!;
  assert.ok(text.includes('scope="src/**"'));
  assert.ok(
    text.indexOf('path="src/AGENTS.md"') <
      text.indexOf('path="src/deep/AGENTS.md"'),
  );
  assert.ok(!text.includes(root));
  assert.equal(reminder(registry, sent), undefined);
  add("tests");
  const next = reminder(registry, sent)!;
  assert.ok(next.includes("Rules for tests"));
  assert.ok(!next.includes("Rules for src"));
  assert.equal(reminder(new Registry(), new Set()), undefined);
});

test("changed content is resent and path attributes are escaped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry();
  registry.root = root;
  const path = join(root, 'src&"/AGENTS.md');
  registry.instructions.set(path, {
    path,
    directory: join(root, 'src&"'),
    content: "old rules",
    mtimeMs: 1,
    size: 1,
  });
  const sent = new Set<string>();
  assert.ok(reminder(registry, sent)!.includes("old rules"));
  registry.instructions.set(path, {
    ...registry.instructions.get(path)!,
    content: "new rules",
    mtimeMs: 2,
  });
  const next = reminder(registry, sent)!;
  assert.ok(next.includes("new rules"));
  assert.ok(next.includes('scope="src&amp;&quot;/**"'));
});
