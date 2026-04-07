# Minsky — Claude Code Instructions

## Subagent Model Routing

When spawning subagents via the Agent tool, use the appropriate model to balance capability with rate limit consumption:

- **`model: "sonnet"`** — Well-defined implementation tasks: applying known fixes, editing specific lines, running tests, committing, file exploration, search, any task with clear instructions and bounded scope.
- **`model: "opus"` (default)** — Complex bug investigation, architectural design and review, multi-step reasoning across many files, tasks where the approach isn't yet clear.

### Subagent Type Routing

Prefer specialized subagent types over `general-purpose` when one fits:

- **`subagent_type: "refactor"`** — Structural code changes (renaming, moving, eliminating layers, consolidating, extracting). Has built-in coherence verification: re-reads modified files end-to-end and reports stale comments, redundant siblings, dead exports, and orphan code. Use whenever the task is a refactor rather than feature work. _Why_: relying on a remembered "verify the result is coherent" rule is structurally weak; the verification belongs in the agent's identity, not in your prompt.
- **`subagent_type: "Explore"`** — Codebase exploration and search.
- **`subagent_type: "Plan"`** — Designing implementation plans before coding.
- **`subagent_type: "general-purpose"`** — Fallback for work that doesn't fit a specialized type.

## Minsky Session Workflow

Minsky sessions are isolated git clones at `~/.local/state/minsky/sessions/<UUID>/` (branch names follow `task/<backend>-<id>` format). The correct working pattern:

1. **ALL work goes through sessions** — even small fixes. Never edit main workspace directly.
2. **Main agent** orchestrates: create tasks, start sessions, launch subagents, review PRs, merge.
3. **Subagents** do the full workflow in session directories: edit code → `mcp__minsky__session_commit` → `mcp__minsky__session_pr_create`. They do NOT merge — that happens after review.
4. **Before creating a PR**, always ensure the session is up-to-date with main. `mcp__minsky__session_pr_create` automatically calls `session_update` (which rebases the session on latest main) before creating the PR — this prevents merge-induced formatting drift and ensures clean fast-forward merges. You can also call `mcp__minsky__session_update` explicitly before committing if needed.
5. **Main agent reviews** the PR by reading the actual diff (via GitHub MCP `pull_request_read` with `get_diff`), then merges with `mcp__minsky__session_pr_merge`. Never approve without reviewing.
6. **When merging multiple PRs sequentially**, each merge may cause conflicts in remaining PRs. Update remaining sessions (`session_update`) after each merge, or resolve conflicts with `session_search_replace` on the conflict markers.
7. All file operations in sessions MUST use absolute paths.
8. **NEVER use bare git CLI** (`git add`, `git commit`, `git push`, `git pull`, `git -C`). Always use MCP tools. Shell `#` in task paths causes parsing issues and permission prompts.
9. **Always quote all Bash arguments** containing `#`, `$`, or special chars if Bash is unavoidable.

### Session lifecycle: one session, one merge

After a session's PR is merged, the session is **frozen** — write operations (`session_pr_create`, `session_pr_edit`, `session_commit`, `session_pr_approve`, `session_update`) will refuse. Read operations still work.

To continue work on the same task with a new PR, delete the old session and start a fresh one:

```
mcp__minsky__session_delete (or `minsky session delete <session>`)
mcp__minsky__session_start  (or `minsky session start --task <task>`)
```

Reusing a session across multiple PRs would silently corrupt PR metadata. The freeze prevents this. Read mt#687 if you're tempted to make this less strict — there's a parked design question about whether the model should change.

### Parallel Task Planning

When launching multiple subagents in parallel, **check for file overlap** between tasks before starting. If two tasks will edit the same file, either:

- Serialize them (run one after the other)
- Explicitly scope each task to skip the shared file
- Partition by file set rather than by pattern category

Merging parallel PRs that touch the same files causes cascading conflicts that require session recreation.

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
- **Lint**: `bun run lint` (0 errors, ~660 warnings — `no-explicit-any` ratchet ongoing)
- **Format**: `bun run format:check` / `bun run format:all`
- **All checks**: `bun run validate-all`

### CI & Branch Protection

- **Main branch is protected** — all PRs must pass CI checks (`build` + `Prevent Placeholder Tests`) before merging.
- **Never merge with failing or pending checks** — always wait for `get_check_runs` to show all checks as `status: "completed"` with `conclusion: "success"` before merging.
- **The build must always be green** — if CI fails, investigate and fix before merging. Never bypass with the GitHub API.
- **Tests must be hermetic** — no environment-dependent tests that pass locally but fail in CI. If a test needs local config/db/git, it's an integration test and must handle missing deps gracefully (not with `test.skipIf(isCI)`).

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
