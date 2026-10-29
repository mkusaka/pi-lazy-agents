import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { discover } from "./discovery.ts";
import type { Discovery } from "./discovery.ts";
import { reminder } from "./injection.ts";
import { Registry } from "./registry.ts";

export default function lazyAgents(pi: ExtensionAPI) {
  let registry = new Registry();
  let pending = new Map<string, Discovery>();
  // Registry entries already appended to a persisted tool result.
  let sent = new Set<string>();

  pi.on("session_start", () => {
    registry = new Registry();
    pending = new Map();
    sent = new Set();
  });

  // Compaction may summarize away earlier reminders; resend on the next result.
  pi.on("session_compact", () => {
    sent = new Set();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !config.enabled ||
      !config.tools.some((tool) => tool === event.toolName)
    )
      return;
    const path = "path" in event.input ? event.input.path : undefined;
    if (typeof path !== "string" || !path) return;
    const current = registry;
    try {
      const discovery = await discover(
        ctx.cwd,
        path,
        event.toolName !== "read",
        current.instructions,
        ctx.isProjectTrusted(),
      );
      // A session replacement may complete while discovery is awaiting the filesystem.
      if (!discovery || current !== registry) return;
      if (event.toolName === "read") pending.set(event.toolCallId, discovery);
      else current.apply(discovery);
    } catch {
      // Never pass filesystem errors (which can include private paths) to pi.
      console.warn("[lazy-agents] Discovery failed; file operation unchanged.");
    }
  });

  pi.on("tool_result", (event) => {
    const discovery = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (discovery && event.toolName === "read" && !event.isError)
      registry.apply(discovery);
    // Nested results reach only the calling tool; attach to its own result instead.
    if (!config.enabled || event.parentToolCallId) return;
    try {
      const text = reminder(registry, sent);
      if (!text) return;
      return {
        content: [...event.content, { type: "text" as const, text }],
        structuredContent: event.structuredContent,
      };
    } catch {
      console.warn(
        "[lazy-agents] Instruction injection failed; tool result unchanged.",
      );
    }
  });
}
