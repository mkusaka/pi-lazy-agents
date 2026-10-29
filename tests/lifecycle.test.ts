import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lazyAgents from "../index.ts";

function runtime(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const forbidden = new Proxy(
    {},
    {
      get: () => {
        throw new Error("Unexpected UI or persistence access");
      },
    },
  );
  const pi = new Proxy(
    {
      on: (name: string, handler: (event: any, ctx: any) => any) =>
        handlers.set(name, handler),
    },
    {
      get: (target, key) =>
        key === "on" ? target.on : Reflect.get(forbidden, key),
    },
  );
  lazyAgents(pi as unknown as ExtensionAPI);
  const emit = (type: string, fields = {}) =>
    handlers.get(type)?.(
      { type, ...fields },
      {
        cwd,
        ui: forbidden,
        isProjectTrusted: () => true,
      },
    );
  const call = (id: string, toolName = "read", path = "sub/x.ts", extra = {}) =>
    emit("tool_call", { toolCallId: id, toolName, input: { path }, ...extra });
  const result = (id: string, isError = false, toolName = "read", extra = {}) =>
    emit("tool_result", {
      toolCallId: id,
      toolName,
      input: { path: "sub/x.ts" },
      content: [{ type: "text", text: "original result" }],
      isError,
      ...extra,
    });
  // Text appended to a tool result, if any.
  const appended = (output: any) =>
    output?.content
      ?.slice(1)
      .map((part: { text: string }) => part.text)
      .join("") as string | undefined;
  return { handlers, emit, call, result, appended };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "AGENTS.md"), "root must not be injected");
  await writeFile(join(root, "sub/AGENTS.md"), "private descendant rules");
  await writeFile(join(root, "sub/x.ts"), "export {};");
  return root;
}

test("reads attach unsent instructions to the successful result once, without UI or session access", async (t) => {
  const rt = runtime(await fixture(t));
  assert.deepEqual([...rt.handlers.keys()].sort(), [
    "session_compact",
    "session_start",
    "tool_call",
    "tool_result",
  ]);
  rt.emit("session_start", { reason: "startup" });
  assert.equal(await rt.call("failed"), undefined);
  assert.equal(rt.result("failed", true), undefined);
  await rt.call("success");
  const output = rt.result("success");
  assert.deepEqual(output.content[0], {
    type: "text",
    text: "original result",
  });
  const text = rt.appended(output)!;
  assert.ok(text.includes("private descendant rules"));
  assert.ok(!text.includes("root must not be injected"));
  for (let index = 0; index < 3; index++) {
    await rt.call(`again-${index}`);
    assert.equal(rt.result(`again-${index}`), undefined);
  }
});

test("edit and write activate before execution and attach even when the operation fails", async (t) => {
  const root = await fixture(t);
  for (const tool of ["edit", "write"]) {
    const rt = runtime(root);
    await rt.call(
      tool,
      tool,
      tool === "write" ? "sub/new/deep.ts" : "sub/x.ts",
    );
    assert.ok(
      rt
        .appended(rt.result(tool, true, tool))!
        .includes("private descendant rules"),
    );
  }
});

test("non-allowlisted tools and malformed paths are ignored", async (t) => {
  const rt = runtime(await fixture(t));
  for (const tool of [
    "bash",
    "grep",
    "find",
    "ls",
    "powershell",
    "tool_search",
    "codemode",
    "custom_read",
  ]) {
    await rt.call(tool, tool);
    assert.equal(rt.result(tool, false, tool), undefined);
  }
  for (const path of [undefined, null, 1, ""]) {
    await rt.emit("tool_call", {
      toolCallId: "bad",
      toolName: "read",
      input: { path },
    });
    assert.equal(rt.result("bad"), undefined);
  }
});

test("nested results stay unchanged and the calling tool's result carries one copy", async (t) => {
  const rt = runtime(await fixture(t));
  const nested = { parentToolCallId: "parent" };
  await Promise.all([
    rt.call("parent/1", "read", "sub/x.ts", nested),
    rt.call("parent/2", "read", "sub/x.ts", nested),
    rt.call("parent/3", "edit", "sub/x.ts", nested),
  ]);
  assert.equal(rt.result("parent/1", false, "read", nested), undefined);
  assert.equal(rt.result("parent/2", true, "read", nested), undefined);
  assert.equal(rt.result("parent/3", true, "edit", nested), undefined);
  const text = rt.appended(rt.result("parent", false, "codemode"))!;
  assert.equal(text.split('<instruction path="sub/AGENTS.md"').length - 1, 1);
  assert.equal(rt.result("later", false, "bash"), undefined);
});

test("compaction resends on the next result; session start and runtime replacement discard memory", async (t) => {
  const root = await fixture(t);
  const rt = runtime(root);
  await rt.call("one");
  assert.ok(rt.appended(rt.result("one")));
  rt.emit("session_compact", {});
  assert.ok(rt.appended(rt.result("after", false, "bash")));
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    await rt.call("pending");
    rt.emit("session_start", { reason });
    assert.equal(rt.result("pending"), undefined);
  }
  assert.equal(runtime(root).result("fresh"), undefined);
  const inFlight = rt.call("in-flight");
  rt.emit("session_start", { reason: "new" });
  await inFlight;
  assert.equal(rt.result("in-flight"), undefined);
});

test("discovery and injection errors leave file operations and tool results unchanged", async (t) => {
  const rt = runtime(await fixture(t));
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) =>
    warnings.push(args.join(" ")),
  );
  assert.equal(await rt.call("invalid", "read", "sub/\0secret.ts"), undefined);
  await rt.call("broken");
  assert.equal(
    rt.result("broken", false, "read", { content: null }),
    undefined,
  );
  assert.deepEqual(warnings, [
    "[lazy-agents] Discovery failed; file operation unchanged.",
    "[lazy-agents] Instruction injection failed; tool result unchanged.",
  ]);
});
