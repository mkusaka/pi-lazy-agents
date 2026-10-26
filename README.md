# pi-lazy-agents

A minimal pi extension that lazily loads `AGENTS.md` files **strictly below cwd**
when `read`, `edit`, or `write` accesses a file in their scope. Pi continues to
load cwd and ancestor context files itself.

## Use

Requires Node.js 24+ for tests. Verified against pi 1.4.0. No build step or runtime
dependencies are needed; pi supplies the extension API.

```sh
pi -e ./index.ts
```

For persistent package installation, run `pi install .` from this directory.
The package manifest declares `index.ts` as the extension entry point.

```text
project/
  AGENTS.md                  # pi loads this
  src/AGENTS.md              # this extension loads this
  src/components/AGENTS.md   # and this
  src/components/button.ts
```

Reading `src/components/button.ts` discovers the two descendant instruction files,
parent first. The next model request receives one hidden, request-local custom
message with relative paths, explicit `src/**` and `src/components/**` scopes, and
more-specific-directory precedence. The system prompt and tool results are unchanged.

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
- The registry is memory-only. Instruction text is not added to UI, logs, tool
  results, or session entries. Warnings contain fixed reasons, never file contents,
  absolute paths, or raw exceptions. Defaults are constants in `config.ts`.
- Nested codemode `read`/`edit`/`write` calls use the same hooks in pi 1.4.0.
  Bash, grep, find, ls, powershell, tool_search, and other tool names are ignored.

## Limits

Instructions affect the **next** inference, not the reasoning that chose the
current tool call. Scopes are model guidance, not enforced isolation or a sandbox.
Instructions go to the model provider, and the model or other extensions may expose
them. Explicitly reading `AGENTS.md` is still an ordinary read whose output pi can
save; this extension does not redact normal file operations.

State survives compaction within the same runtime, but starts empty on process
restart, session replacement, or extension reload. History is not replayed on
`--continue`; the next eligible file access repopulates the registry. Metadata-only
caching cannot detect same-size edits with unchanged mtime. There is no total
instruction-token budget and no support for other instruction filenames.

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

Keep `bun.lock` in version control. `bunfig.toml` requires newly resolved packages
to be at least seven days old. Checking and formatting use Bun's built-ins; the
`fmt` script uses `--no-script` to avoid recursion. Oxlint uses its default rules.
Pi 1.3.0 and Node.js types are development-only dependencies for type checking;
pi remains an optional peer dependency. `skipLibCheck` skips incompatible upstream
declaration files, while project source and tests are checked in strict mode with
only erasable TypeScript syntax.

Tests use Node's native TypeScript stripping and temporary runtime fixtures, with
no additional test runner. They cover discovery, caching, hooks, parallel/nested
calls, context ordering, lifecycle, and security failures.

Real-pi smoke tests verified direct and nested codemode reads, canary compliance
after the tool result, `--continue`, root non-duplication, and no descendant
instruction text in stdout/stderr or session JSONL. Offline checks of pi 1.4.0's
ten API serializers preserved tool-call/result references and placed one reminder
after results; live provider verification was limited to OpenAI.

API references: pi's `extensions.md`, `message-types.md`, `codemode.md`, `cli.md`,
`packages.md`, `compaction.md`, `session-format.md`, and `configuration.md`.

## Release

1. Run the checks above and `npm pack --dry-run`. In a local checkout, temporarily
   set `version` in `package.json` to `0.0.1-stage.0` and manually run
   `npm publish --tag stage` from an authenticated terminal. Restore `0.0.1`.
2. On npmjs.com, configure a GitHub Actions trusted publisher with owner `mkusaka`,
   repository `pi-lazy-agents`, and workflow filename `publish.yml`. Allow direct
   `npm publish`.
3. Push tag `v0.0.1` for the reviewed release commit. For later releases, bump the
   version, run `bun install` and the checks above, and push the matching `vX.Y.Z` tag.

The placeholder lets npm create the package before
[trusted publishing is configured](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).
The workflow checks the tag, skips versions already on npm, and uses Node 24's
bundled npm for token-free OIDC publishing with automatic provenance from a public
repository. Complete the first trusted publish within two days of configuration.
