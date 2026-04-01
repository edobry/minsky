<!-- Generated from Minsky rules. See .cursor/rules/ for full rule set. -->

# Minsky — Agent Instructions

Minsky is a task management and AI workflow orchestration tool that manages isolated coding sessions backed by git. It exposes both a CLI and 80+ MCP tools for task, session, and rule management.

- **Runtime**: Bun (not Node.js) — use `bun` for all commands
- **Language**: TypeScript strict mode
- **Architecture**: Clean architecture — Domain → Adapters → Infrastructure
- **Interfaces**: CLI (Commander.js) and MCP, both backed by the same domain logic

## Build & Test Commands

```bash
# Run all tests
bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain

# Lint (17 auto-fixable errors with --fix)
bun run lint
bun run lint --fix

# Format
bun run format:check
bun run format:all

# Run all checks (lint + format + typecheck)
bun run validate-all
```

Always use `bun` instead of `node`, `npm`, or `npx`. Prefer `bun install`, `bun run`, `bun test`, `bun build`.

## Code Style

- Double quotes, 2-space indent, 100-char line width, LF line endings
- ES5 trailing commas everywhere
- Prefer template literals over string concatenation: `` `Hello ${name}` `` not `"Hello " + name`
- All code symbols (variables, functions, identifiers) must use ASCII characters only — no accented letters, emoji, or Unicode in symbol names
- Extract string constants that appear 3+ times; organize constants by domain in `constants/` files
- Comments explain **why**, not what. Delete comments that restate what the code obviously does. Keep comments that explain non-obvious decisions, business rules, or gotchas.
- Max ~400 lines per file; extract submodules along domain lines rather than arbitrarily splitting

## Architecture

Minsky uses a strict three-layer structure:

- `src/domain/` — pure business logic, interface-agnostic, organized by domain concept (`tasks.ts`, `git.ts`, `session.ts`)
- `src/adapters/cli/` and `src/adapters/mcp/` — convert interface input/output, format errors per interface
- `src/commands/` — entry points; define schemas, delegate to adapters

**Key rules:**

- Domain functions are interface-agnostic; adapters own formatting and error presentation
- Use Zod schemas for parameter validation; define once, reuse across CLI and MCP
- Group code by domain concept, not technical category (co-locate related functions)
- Avoid cross-module dependencies; place domain-specific utilities with their domain module
- Commands are defined once and adapted — never duplicate logic between CLI and MCP layers

## Testing

Run: `bun test --preload ./tests/setup.ts --timeout=15000`

**Principles:**

- Follow Arrange-Act-Assert; use `describe`/`it` blocks with clear, action-oriented names
- Test files live alongside source files: `foo.ts` → `foo.test.ts`
- Use dependency injection rather than complex mocking; avoid patching module internals
- Prefer in-memory stubs over real filesystem/network operations unless testing I/O explicitly
- Test behaviors and public API contracts, not implementation details or internal call counts
- Test both success and failure paths; verify error types and messages
- Reset state between tests with `beforeEach`/`afterEach`; never rely on test execution order
- For CLI commands, prefer integration tests that invoke handlers directly with injected deps over spawning processes

## Git & PR Workflow

- **Never force-push** to shared branches (`main`, `develop`, release branches) without explicit user approval
- Create small, atomic commits with messages that explain _why_, not just what
- PR title format: `type(scope): description` — e.g., `feat(#042): Add session export command`
  - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- PR body: start with `## Summary` (no title duplication). Include Motivation, Design/Approach, Key Changes, Testing
- Never commit PR description files to the repository — pass body inline via `--body` or heredoc
- Before destructive git operations (`reset`, `rebase`, `push --force`): document current state, predict outcome, prefer safer alternatives (`git revert`, new branch)
- Use `git -C "<path>"` instead of `cd <path> && git` to avoid shell security prompts

## Minsky Workflow

All implementation work happens in **sessions** — isolated git clones at `~/.local/state/minsky/sessions/task-mt#<ID>/`.

### Key Commands (CLI)

```bash
minsky tasks list [--status <value>] [--filter <value>]
minsky tasks get <taskId>
minsky session start --task <taskId>
minsky session dir --task <taskId>
minsky session pr create [--title <value>] [--body <value>]
minsky tasks status.set <taskId> --status IN-REVIEW
```

### MCP Tool Namespaces

- `mcp__minsky__tasks_*` — task CRUD, status, specs, deps
- `mcp__minsky__session_*` — session lifecycle, PRs, file operations
- `mcp__minsky__rules_*` — project rules

**Prefer MCP tools over CLI** to avoid shell-parsing issues with `#` in task IDs.

### Session Constraints

- **All file operations in sessions MUST use absolute paths** — many tools resolve relative paths against the main workspace root, not the shell CWD
- Session path pattern: `/Users/edobry/.local/state/minsky/sessions/task-mt#<ID>/<file>`
- Never edit files in the main workspace during an active session; changes go through the session branch and PR
- Never copy files manually between workspaces; the session already contains all project files

### Orchestration Pattern

1. **Main agent**: orchestrates via MCP tools (create tasks, start sessions, manage status, create PRs, run git operations)
2. **Subagents**: do implementation work in session directories (read, edit, run tests)
3. After subagent completes: main agent verifies changes, runs tests, commits, pushes

## Boundaries & Safety

**Destructive operations default to dry-run.** Require an explicit `--execute` flag to apply. Always show a preview plan first.

```bash
# Preview (safe default)
minsky sessiondb migrate

# Apply (must be explicit)
minsky sessiondb migrate --execute
```

**Shell commands:**

- Use ASCII quotes only (`"` and `'`) — never smart/curly quotes
- Prefer single quotes over double quotes to avoid shell interpretation issues
- Break complex command chains into multiple simple commands rather than chaining 10+ `&&` operators

**Code symbols:** All identifiers must be ASCII. Non-ASCII characters are allowed only in string literals and comments.

## Gotchas

**Variable naming can cause infinite test loops.** If a variable is declared as `_foo` but used as `foo` (or vice versa), async operations may deadlock rather than fail with a clear error. Symptom: tests running for billions of milliseconds. Fix: remove the underscore from the _definition_, not the usage. Never add underscores to variables that are already working — only use underscore prefix for genuinely unused parameters.
