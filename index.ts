import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { discover } from "./discovery.ts";
import type { Discovery } from "./discovery.ts";
import { inject } from "./injection.ts";
import { Registry } from "./registry.ts";

export default function lazyAgents(pi: ExtensionAPI) {
  let registry = new Registry();
  let pending = new Map<string, Discovery>();

  pi.on("session_start", () => {
    registry = new Registry();
    pending = new Map();
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
  });

  pi.on("context", (event) => {
    if (!config.enabled) return;
    try {
      return { messages: inject(event.messages, registry) };
    } catch {
      console.warn(
        "[lazy-agents] Context injection failed; context unchanged.",
      );
    }
  });
}
