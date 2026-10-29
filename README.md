# pi-lazy-agents

A minimal pi extension that lazily loads `AGENTS.md` files **strictly below cwd**
when `read`, `edit`, or `write` accesses a file in their scope, along with skills
from `.agents/skills` in those same descendant directories. Pi continues to load
cwd and ancestor context files and `.agents/skills` itself.

## Install

```sh
pi install npm:pi-lazy-agents
```

Add `-l` to write the declaration to the project's `.pi/settings.json` instead of
`~/.pi/agent/settings.json`. To try it for one invocation without installing:

```sh
pi -e npm:pi-lazy-agents
```

Verified against pi 1.4.0. No build step or runtime dependencies; pi supplies the
extension API.

## How it works

```text
project/
  AGENTS.md                  # pi loads this
  src/AGENTS.md              # this extension loads this
  src/components/AGENTS.md   # and this
  src/components/button.ts
```

Reading `src/components/button.ts` discovers the two descendant instruction files,
parent first. Their text is appended once to the end of that tool result, with
relative paths, explicit `src/**` and `src/components/**` scopes, and
more-specific-directory precedence. Because the reminder is part of the persisted
tool result, the conversation prefix stays stable and the provider prompt cache keeps
growing. The system prompt is unchanged.

`src/.agents/skills` is discovered the same way. As with pi's own skill list, only
each skill's name, description, and cwd-relative `SKILL.md` location are injected;
the model reads the body when a task matches. `disable-model-invocation` skills are
not listed. Skills load only when `ctx.isProjectTrusted()` is true. Pi's trust
prompt checks only cwd and ancestors, so a project whose only skills are nested is
auto-trusted and its skills load without a prompt.

## Behavior and safety

- Discovery happens before execution. Reads activate candidates only after a
  successful result; edits and writes activate them regardless of operation success.
- Missing write/edit targets are resolved through existing ancestors, including
  when intermediate directories have not been created yet.
- Canonical paths enforce the cwd boundary and deduplicate symlink aliases.
  Instruction-file aliases share one record with the most recently discovered scope.
- Reaccess checks mtime and size. Changed files are reread; deleted or rejected
  instructions are removed when that scope is next successfully rediscovered.
- Only regular UTF-8 files up to 64 KiB are accepted, with fatal decoding and bounded
  reads. BOM and line endings are normalized. Outside-cwd symlinks are rejected.
- The registry is memory-only. Instruction text is appended to tool results and
  therefore saved in the session file; it is not added to UI or logs. Warnings contain fixed reasons, never file contents,
  absolute paths, or raw exceptions. Defaults are constants in `config.ts`.
- Nested codemode `read`/`edit`/`write` calls use the same hooks in pi 1.4.0.
  Their results reach only the calling tool, so the reminder is appended to the
  calling tool's own result instead. Bash, grep, find, ls, powershell, tool_search,
  and other tool names do not trigger discovery.

## Limits

Instructions affect the **next** inference, not the reasoning that chose the
current tool call. Each instruction is sent once per content version (mtime and size);
a changed file is sent again, but a deleted one stays in earlier history. Scopes are model guidance, not enforced isolation or a sandbox.
Instructions go to the model provider, and the model or other extensions may expose
them. Explicitly reading `AGENTS.md` is still an ordinary read whose output pi can
save; this extension does not redact normal file operations.

State survives compaction within the same runtime, and the next tool result after
compaction resends every loaded instruction. State starts empty on process restart,
session replacement, or extension reload. On `--continue`, the next eligible file
access sends the instructions again even if earlier history already has them. Metadata-only
caching cannot detect same-size edits with unchanged mtime. There is no total
instruction-token budget and no support for other instruction filenames.

Lazily discovered skills are listed for the model only: they are not registered
as `/skill:name` commands, and name collisions with pi-loaded skills or with each
other are not deduplicated. Root-level `.md` files in `.agents/skills` are ignored
as in pi, but nested `.md` files outside a `SKILL.md` directory are not loaded. Skill directories
are rescanned on every eligible access without a size limit; skill files that
resolve outside cwd are dropped.

## Development

Use Bun 1.4.4 and Node.js 24+:

```sh
bun install
bun check # or bun run typecheck
bun fmt
bun fmt --check
bun run lint
bun run test
```

Load the checkout in pi with `pi -e ./index.ts`.

Keep `bun.lock` in version control. `bunfig.toml` requires newly resolved packages
to be at least seven days old. Checking and formatting use Bun's built-ins; the
`fmt` script uses `--no-script` to avoid recursion. Oxlint uses its default rules.
Pi 1.3.0 and Node.js types are development-only dependencies for type checking;
pi remains an optional peer dependency. `skipLibCheck` skips incompatible upstream
declaration files, while project source and tests are checked in strict mode with
only erasable TypeScript syntax.

Tests use Node's native TypeScript stripping and temporary runtime fixtures, with
no additional test runner. They cover discovery, caching, hooks, parallel/nested
calls, reminder deduplication, lifecycle, and security failures.

A real-pi smoke test (pi 1.4.0, OpenAI, six sequential reads under `sub/`) verified
canary compliance, exactly one reminder in the session JSONL, and cached input
growing on every request (18.2k to 35.8k tokens), where the previous request-local
`context` injection stayed at 18.2k. Nested codemode reads have not been re-verified
against a live provider since that change.

API references: pi's `extensions.md`, `message-types.md`, `codemode.md`, `cli.md`,
`packages.md`, `compaction.md`, `session-format.md`, and `configuration.md`.

## Release

Publishing runs from `.github/workflows/publish.yml` with npm trusted publishing
(OIDC, no token, automatic provenance). To release:

1. Bump `version` in `package.json`, run `bun install` and the checks above, and
   commit.
2. Push the matching `vX.Y.Z` tag.

The workflow reruns the checks, verifies that the tag matches `package.json`, and
skips versions already on npm.
