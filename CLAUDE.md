# Minsky — Claude Code Instructions

## Subagent Model Routing

When spawning subagents via the Agent tool, use the appropriate model to balance capability with rate limit consumption:

- **`model: "sonnet"`** — Well-defined implementation tasks: applying known fixes, editing specific lines, running tests, committing, file exploration, search, any task with clear instructions and bounded scope.
- **`model: "opus"` (default)** — Complex bug investigation, architectural design and review, multi-step reasoning across many files, tasks where the approach isn't yet clear.

## Minsky Session Workflow

Minsky sessions are isolated git clones at `~/.local/state/minsky/sessions/task-mt#<ID>/`. The correct working pattern:

1. **Main agent** orchestrates via MCP tools: create tasks, start sessions, manage status, create PRs. Also handles git operations (commit, push) since background subagents cannot run Bash commands.
2. **Subagents** do implementation work in session directories: read files, edit code, run tests. Never edit session files from the main agent.
3. After a subagent completes, the main agent verifies changes, runs tests, commits, and pushes.
4. All file operations in sessions MUST use absolute paths.
5. Use `git -C "<session-path>"` instead of `cd <path> && git` to avoid Claude Code security prompts.
6. Prefer Minsky MCP tools over CLI for task/session operations to avoid shell parsing issues with `#` in task IDs.

## MCP Tools

Minsky exposes 80+ MCP tools. Use them for all task and session operations instead of shelling out to the CLI:

- `mcp__minsky__tasks_*` — task CRUD, status, specs, deps
- `mcp__minsky__session_*` — session lifecycle, PRs, file operations
- `mcp__minsky__rules_*` — project rules
- `mcp__minsky__persistence_*` — database operations

## Build & Test

- **Install**: `bun install` (required before running any checks; automated via SessionStart hook for web sessions)
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
