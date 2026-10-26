import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../config.ts";
import { discover } from "../discovery.ts";
import { Registry } from "../registry.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-security-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const root = join(base, "project");
  const outside = join(base, "outside");
  for (const directory of [root, outside, join(root, "sub")])
    await mkdir(directory);
  await writeFile(join(root, "sub/x.ts"), "export {};");
  await writeFile(join(outside, "x.ts"), "export {};");
  return { root, outside };
}

test("realpath rejects escaping file, directory, instruction, and dangling symlinks", async (t) => {
  const { root, outside } = await fixture(t);
  const secret = "OUTSIDE-INSTRUCTION-CANARY";
  await writeFile(join(outside, "AGENTS.md"), secret);
  await symlink(outside, join(root, "linked"), "dir");
  await symlink(join(outside, "x.ts"), join(root, "sub/escape.ts"));
  await symlink(join(outside, "AGENTS.md"), join(root, "sub/AGENTS.md"));
  await symlink(join(outside, "missing"), join(root, "dangling"));
  for (const path of [
    "linked/x.ts",
    "linked/new/file.ts",
    "sub/escape.ts",
    "dangling/new.ts",
  ]) {
    assert.equal(await discover(root, path, true, new Map()), undefined);
  }
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  await unlink(join(root, "sub/AGENTS.md"));
  await writeFile(join(root, "AGENTS.md"), "ROOT-INSTRUCTION-CANARY");
  await symlink(join(root, "AGENTS.md"), join(root, "sub/AGENTS.md"));
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  await unlink(join(root, "sub/AGENTS.md"));
  await writeFile(join(root, "sub/AGENTS.md"), "inside rules");
  await symlink(join(root, "sub"), join(root, "alias"), "dir");
  const registry = new Registry();
  for (const path of ["sub/x.ts", "alias/x.ts"]) {
    const result = await discover(root, path, false, registry.instructions);
    assert.ok(result);
    registry.apply(result);
  }
  assert.equal(registry.instructions.size, 1);
});

test("size limits and fatal UTF-8 decoding reject entire files with content-free warnings", async (t) => {
  const { root } = await fixture(t);
  const warnings: string[] = [];
  for (const method of ["log", "info", "debug", "error"] as const) {
    t.mock.method(console, method, () =>
      assert.fail("Unexpected console output"),
    );
  }
  t.mock.method(console, "warn", (...args: unknown[]) =>
    warnings.push(args.join(" ")),
  );
  const canary = "PRIVATE-INSTRUCTION-CANARY";
  const file = join(root, "sub/AGENTS.md");
  await writeFile(file, canary + "x".repeat(config.maxFileSizeBytes));
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  await writeFile(
    file,
    Buffer.concat([Buffer.from(canary), Buffer.from([0xc3, 0x28])]),
  );
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  await writeFile(file, "x".repeat(config.maxFileSizeBytes));
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions[0].size,
    config.maxFileSizeBytes,
  );
  await unlink(file);
  await mkdir(file);
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  assert.deepEqual(warnings, [
    "[lazy-agents] Skipped instructions (too-large).",
    "[lazy-agents] Skipped instructions (invalid-utf8).",
    "[lazy-agents] Skipped instructions (not-a-file).",
  ]);
  assert.ok(!warnings.join("\n").includes(canary));
  assert.ok(!warnings.join("\n").includes(root));
});

test("permission errors skip instructions without logging contents or filesystem errors", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32")
    return t.skip("Requires POSIX file permissions and a non-root process");
  const { root } = await fixture(t);
  const file = join(root, "sub/AGENTS.md");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) =>
    warnings.push(args.join(" ")),
  );
  await writeFile(file, "PRIVATE-PERMISSION-CANARY");
  await chmod(file, 0);
  t.after(() => chmod(file, 0o600).catch(() => {}));
  assert.equal(
    (await discover(root, "sub/x.ts", false, new Map()))?.instructions.length,
    0,
  );
  assert.deepEqual(warnings, [
    "[lazy-agents] Skipped instructions (unreadable).",
  ]);
});
