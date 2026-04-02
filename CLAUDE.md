# Minsky — Claude Code Instructions

## Subagent Model Routing

When spawning subagents via the Agent tool, use the appropriate model to balance capability with rate limit consumption:

- **`model: "sonnet"`** — Well-defined implementation tasks: applying known fixes, editing specific lines, running tests, committing, file exploration, search, any task with clear instructions and bounded scope.
- **`model: "opus"` (default)** — Complex bug investigation, architectural design and review, multi-step reasoning across many files, tasks where the approach isn't yet clear.

## Minsky Session Workflow

Minsky sessions are isolated git clones at `~/.local/state/minsky/sessions/task-mt#<ID>/`. The correct working pattern:

1. **ALL work goes through sessions** — even small fixes. Never edit main workspace directly.
2. **Main agent** orchestrates: create tasks, start sessions, launch subagents, review PRs, merge.
3. **Subagents** do the full workflow in session directories: edit code → `mcp__minsky__session_commit` → `mcp__minsky__session_pr_create`. They do NOT merge — that happens after review.
4. **Before creating a PR**, always ensure the session is up-to-date with main. `mcp__minsky__session_pr_create` automatically calls `session_update` (which rebases the session on latest main) before creating the PR — this prevents merge-induced formatting drift and ensures clean fast-forward merges. You can also call `mcp__minsky__session_update` explicitly before committing if needed.
5. **Main agent reviews** the PR (or launches review agents that post on the PR via GitHub MCP), then merges with `mcp__minsky__session_pr_merge`.
6. All file operations in sessions MUST use absolute paths.
7. **NEVER use bare git CLI** (`git add`, `git commit`, `git push`, `git pull`, `git -C`). Always use MCP tools. Shell `#` in task paths causes parsing issues and permission prompts.
8. **Always quote all Bash arguments** containing `#`, `$`, or special chars if Bash is unavoidable.

## Task Completion Protocol

A PR merging is NOT the same as a task being complete. Before marking any task DONE:

1. **Re-read the task spec** — fetch it with `tasks_spec_get` and review every success criterion
2. **Check each criterion** — verify the PR/code actually delivers it, not just something adjacent
3. **If scope was reduced**, update the spec FIRST to reflect actual scope, note what was deferred, and create follow-up tasks for gaps before marking DONE
4. **If criteria can't be verified**, the task is not DONE — use IN-REVIEW or create follow-up tasks

Never treat "code merged" as equivalent to "task complete." The spec defines completeness, not the PR.

## MCP Tools

Minsky exposes 80+ MCP tools. Use them for all task and session operations instead of shelling out to the CLI:

- `mcp__minsky__tasks_*` — task CRUD, status, specs, deps
- `mcp__minsky__session_*` — session lifecycle, PRs, file operations
- `mcp__minsky__rules_*` — project rules
- `mcp__minsky__persistence_*` — database operations

## Build & Test

- **Runtime**: Bun (not Node.js)
- **Tests**: `bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain`
- **Lint**: `bun run lint` (17 errors are auto-fixable with `--fix`)
- **Format**: `bun run format:check` / `bun run format:all`
- **All checks**: `bun run validate-all`

## Code Style

- TypeScript strict mode, double quotes, 2-space indent, 100-char line width
- ES5 trailing commas, LF line endings
- Prefer template literals over string concatenation
- Max 400 lines per file (warn), 1500 (error)
- 10 custom ESLint rules enforce architectural patterns

## Key Architecture

- Clean architecture: Domain → Adapters → Infrastructure
- Shared command registry: commands defined once, adapted to CLI and MCP
- Capability-based persistence providers (ADR-002)
- Multi-backend tasks: markdown, JSON, GitHub Issues, Minsky DB
