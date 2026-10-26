import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { inject } from "../injection.ts";
import { Registry } from "../registry.ts";

type AgentMessage = ContextEvent["messages"][number];

function reminderText(messages: AgentMessage[]): string {
  const reminder = messages.at(-1);
  assert.ok(reminder?.role === "custom");
  return String(reminder.content);
}

test("one hidden request-local custom message follows intact tool pairs and preserves system state", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const registry = new Registry();
  registry.root = root;
  for (const directory of ["src/deep", "tests", "src"]) {
    const path = join(root, directory, "AGENTS.md");
    registry.instructions.set(path, {
      path,
      directory: join(root, directory),
      content: `Rules for ${directory}`,
      mtimeMs: 1,
      size: 1,
    });
  }
  const messages = [
    { role: "system", content: "unchanged system prompt", timestamp: 1 },
    { role: "user", content: "read two files", timestamp: 2 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "a",
          name: "read",
          arguments: { path: "src/x.ts" },
        },
        {
          type: "toolCall",
          id: "b",
          name: "read",
          arguments: { path: "tests/x.ts" },
        },
      ],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "b",
      toolName: "read",
      content: [{ type: "text", text: "second file" }],
      isError: false,
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "read",
      content: [{ type: "text", text: "first file" }],
      isError: false,
      timestamp: 5,
    },
    {
      role: "custom",
      customType: "another-extension",
      content: "keep me",
      display: false,
      timestamp: 6,
    },
  ] as AgentMessage[];
  const snapshot = structuredClone(messages);
  const result = inject(messages, registry);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(result.slice(0, -1), messages);
  assert.equal(result[0], messages[0]);
  const reminder = result.at(-1);
  assert.equal(reminder?.role, "custom");
  assert.equal(reminder?.display, false);
  const text = String(reminder?.content);
  assert.ok(text.includes('scope="src/**"'));
  assert.ok(text.includes('scope="tests/**"'));
  assert.ok(
    text.indexOf('path="src/AGENTS.md"') <
      text.indexOf('path="src/deep/AGENTS.md"'),
  );
  assert.ok(!text.includes(root));
  assert.equal(inject(result, registry).length, result.length);
  registry.instructions.clear();
  assert.deepEqual(inject(result, registry), messages);
});

test("context rebuilds use current content, escape path attributes, and survive compaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lazy-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry();
  registry.root = root;
  const path = join(root, 'src&"/AGENTS.md');
  const instruction = {
    path,
    directory: join(root, 'src&"'),
    content: "old rules",
    mtimeMs: 1,
    size: 1,
  };
  registry.instructions.set(path, instruction);
  const first = inject([], registry);
  instruction.content = "new rules";
  const compacted = [
    {
      role: "compactionSummary",
      summary: "older history",
      tokensBefore: 100,
      timestamp: 1,
    },
  ] as AgentMessage[];
  const next = inject(compacted, registry);
  assert.ok(reminderText(first).includes("old rules"));
  assert.ok(reminderText(next).includes("new rules"));
  assert.ok(!reminderText(next).includes("old rules"));
  assert.ok(reminderText(next).includes('scope="src&amp;&quot;/**"'));
  assert.deepEqual(next.slice(0, -1), compacted);
  assert.deepEqual(inject([], new Registry()), []);
});
