import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { discover } from "../discovery.ts";
import { ancestorDirectories, isWithin } from "../path.ts";

test("discovery visits only descendant ancestors, parent first, for relative and absolute paths", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  for (const [path, content] of [
    ["AGENTS.md", "root"],
    ["src/AGENTS.md", "parent"],
    ["src/components/AGENTS.md", "child"],
    ["tests/AGENTS.md", "unrelated"],
    ["src/components/x.ts", "export {};"],
    ["src/CLAUDE.md", "ignored"],
  ]) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  for (const path of [
    "src/components/x.ts",
    "src/./components/../components/x.ts",
    join(root, "src/components/x.ts"),
  ]) {
    const result = await discover(root, path, false, new Map());
    assert.deepEqual(
      result?.instructions.map((item) => item.content),
      ["parent", "child"],
    );
    assert.deepEqual(result?.directories, [
      join(root, "src"),
      join(root, "src/components"),
    ]);
  }
  assert.equal(
    (await discover(root, "AGENTS.md", false, new Map()))?.instructions.length,
    0,
  );
  assert.equal(
    await discover(root, "../outside.ts", true, new Map()),
    undefined,
  );
  assert.equal(isWithin(root, `${root}-sibling/file.ts`), false);
  assert.deepEqual(
    ancestorDirectories(root, join(dirname(root), "outside.ts")),
    [],
  );
});

test("missing write targets use existing ancestors, including newly created directory paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub/AGENTS.md"), "\ufeffFirst\r\nSecond\rThird");
  for (const path of ["sub/new.ts", "sub/new/deeper/file.ts"]) {
    const result = await discover(root, path, true, new Map());
    assert.deepEqual(
      result?.instructions.map((item) => item.content),
      ["First\nSecond\nThird"],
    );
  }
  await assert.rejects(discover(root, "sub/missing.ts", false, new Map()), {
    code: "ENOENT",
  });
});
