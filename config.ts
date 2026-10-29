export const config = {
  enabled: true,
  tools: ["read", "edit", "write"],
  boundary: "cwd",
  maxFileSizeBytes: 65536,
  refreshOnAccess: true,
  injectMode: "tool_result",
  persistRegistry: false,
} as const;
