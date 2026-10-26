import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discover } from "../discovery.ts";
import { Registry } from "../registry.ts";

test("registry deduplicates, refreshes by mtime/size, invalidates deletions, and retains other scopes", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  for (const scope of ["src", "tests"]) {
    await mkdir(join(root, scope));
    await writeFile(join(root, scope, "AGENTS.md"), scope);
    await writeFile(join(root, scope, "x.ts"), "export {};");
  }
  const registry = new Registry();
  const access = async (scope: string) => {
    const result = await discover(root, `${scope}/x.ts`, false, registry.instructions);
    assert.ok(result);
    registry.apply(result);
  };
  await access("src");
  const original = registry.instructions.get(join(root, "src/AGENTS.md"));
  await access("src");
  assert.equal(registry.instructions.size, 1);
  assert.deepEqual(registry.instructions.get(join(root, "src/AGENTS.md")), original);
  assert.equal(registry.visitedFiles.size, 1);
  await access("tests");
  assert.equal(registry.instructions.size, 2);
  await writeFile(join(root, "src/AGENTS.md"), "new");
  const future = new Date(Date.now() + 10000);
  await utimes(join(root, "src/AGENTS.md"), future, future);
  await access("src");
  assert.equal(registry.instructions.get(join(root, "src/AGENTS.md"))?.content, "new");
  await writeFile(join(root, "src/AGENTS.md"), "longer instructions");
  await access("src");
  assert.equal(registry.instructions.get(join(root, "src/AGENTS.md"))?.content, "longer instructions");
  await unlink(join(root, "src/AGENTS.md"));
  await access("src");
  assert.equal(registry.instructions.size, 1);
  assert.equal([...registry.instructions.values()][0].content, "tests");
});
