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
    handlers.get(type)?.({ type, ...fields }, { cwd, ui: forbidden });
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
  const context = (messages = []) =>
    emit("context", { messages })?.messages ?? messages;
  return { handlers, emit, call, result, context };
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

test("read stages candidates until success and never modifies tool results, UI, or sessions", async (t) => {
  const rt = runtime(await fixture(t));
  assert.deepEqual([...rt.handlers.keys()].sort(), [
    "context",
    "session_start",
    "tool_call",
    "tool_result",
  ]);
  rt.emit("session_start", { reason: "startup" });
  assert.equal(await rt.call("failed"), undefined);
  assert.equal(rt.context().length, 0);
  assert.equal(rt.result("failed", true), undefined);
  assert.equal(rt.context().length, 0);
  await rt.call("success");
  const event = {
    type: "tool_result",
    toolCallId: "success",
    toolName: "read",
    input: {},
    isError: false,
    content: [{ type: "text", text: "original file" }],
  };
  const snapshot = structuredClone(event);
  assert.equal(rt.handlers.get("tool_result")!(event, {}), undefined);
  assert.deepEqual(event, snapshot);
  assert.equal(rt.context().length, 1);
  assert.ok(
    String(rt.context()[0].content).includes("private descendant rules"),
  );
  assert.ok(
    !String(rt.context()[0].content).includes("root must not be injected"),
  );
  for (let index = 0; index < 3; index++) {
    await rt.call(`again-${index}`);
    rt.result(`again-${index}`);
    assert.equal(rt.context().length, 1);
  }
});

test("edit and write activate before execution even when the operation fails", async (t) => {
  const root = await fixture(t);
  for (const tool of ["edit", "write"]) {
    const rt = runtime(root);
    assert.equal(
      await rt.call(
        tool,
        tool,
        tool === "write" ? "sub/new/deep.ts" : "sub/x.ts",
      ),
      undefined,
    );
    assert.equal(rt.context().length, 1);
    assert.equal(rt.result(tool, true, tool), undefined);
    assert.equal(rt.context().length, 1);
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
    rt.result(tool, false, tool);
  }
  for (const path of [undefined, null, 1, ""]) {
    await rt.emit("tool_call", {
      toolCallId: "bad",
      toolName: "read",
      input: { path },
    });
  }
  assert.equal(rt.context().length, 0);
});

test("parallel and nested read/edit/write hooks deduplicate and correlate by toolCallId", async (t) => {
  const root = await fixture(t);
  const rt = runtime(root);
  await Promise.all([
    rt.call("parent/1", "read", "sub/x.ts", { parentToolCallId: "parent" }),
    rt.call("parent/2"),
    rt.call("failed"),
  ]);
  rt.result("failed", true);
  rt.result("parent/2");
  rt.result("parent/1", false, "read", { parentToolCallId: "parent" });
  for (const tool of ["edit", "write"]) {
    await rt.call(`parent/${tool}`, tool, "sub/x.ts", {
      parentToolCallId: "parent",
    });
    rt.result(`parent/${tool}`, true, tool, { parentToolCallId: "parent" });
  }
  assert.equal(rt.context().length, 1);
  assert.equal(
    String(rt.context()[0].content).split('<instruction path="sub/AGENTS.md"')
      .length - 1,
    1,
  );
});

test("compaction retains memory; session start and runtime replacement discard it", async (t) => {
  const root = await fixture(t);
  const rt = runtime(root);
  await rt.call("one");
  rt.result("one");
  rt.emit("session_compact", {});
  assert.equal(
    rt.context([{ role: "compactionSummary", summary: "compacted" }] as any)
      .length,
    2,
  );
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    await rt.call("pending");
    rt.emit("session_start", { reason });
    rt.result("pending");
    assert.equal(rt.context().length, 0);
  }
  assert.equal(runtime(root).context().length, 0);
  const inFlight = rt.call("in-flight");
  rt.emit("session_start", { reason: "new" });
  await inFlight;
  rt.result("in-flight");
  assert.equal(rt.context().length, 0);
});

test("discovery and context errors leave file operations and the existing context unchanged", async (t) => {
  const rt = runtime(await fixture(t));
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) =>
    warnings.push(args.join(" ")),
  );
  assert.equal(await rt.call("invalid", "read", "sub/\0secret.ts"), undefined);
  const messages = Object.create(null);
  assert.equal(rt.emit("context", { messages }), undefined);
  assert.deepEqual(warnings, [
    "[lazy-agents] Discovery failed; file operation unchanged.",
    "[lazy-agents] Context injection failed; context unchanged.",
  ]);
});
