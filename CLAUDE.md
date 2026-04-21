# Minsky — Claude Code Instructions

## Subagent Routing

When spawning subagents, use the appropriate model and type:

**Models:** `"sonnet"` for bounded tasks (implementation, refactoring, search, committing). `"opus"` (default) for complex investigation, architectural design, multi-step reasoning. `"haiku"` for simple search/formatting.

**Types:** `"refactor"` for structural changes (built-in coherence verification). `"verify-completion"` for spec verification. `"reviewer"` for read-only PR review. `"Explore"` for codebase search. `"Plan"` for design. `"general-purpose"` as fallback.

**Capacity:** Subagents have limited context/tool budgets with no graceful degradation. Scope to 8–12 files per wave. Instruct to commit incrementally. For multi-phase work, use subtasks (`tasks_create` with `parent`). If a subagent returns incomplete work, check session `git diff`/`git status` and finish from main agent.

**Prompt generation:** Always use `mcp__minsky__session_generate_prompt` — never hand-craft prompts. It enforces correct sessionId, taskId, paths, scope bounds, and guard rails. Dispatch with `suggestedModel` and `suggestedSubagentType` from the result.

## Task Lifecycle

```
TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE
       (investigate) (gate)  (session_start) (pr_create)  (verify + merge)

Also: BLOCKED (from PLANNING, READY, or IN-PROGRESS), CLOSED (from any state)
```

Transitions are enforced in the domain layer. `session_start` blocks from TODO/PLANNING — task must be READY first. See `/orchestrate` skill for full workflow details.

## Work Completion

- **Do not defer identified, actionable work.** Complete unmet success criteria before proposing to ship.
- **The user decides scope, not the agent.** Never unilaterally decide "this is a good stopping point."
- **Artifact creation is not progress.** Creating tasks/specs/rules is not a substitute for doing the work.
- **Never notice an issue without acting on it.** File a task, update a spec, or save a memory — mentioning in chat is not action.
- **Process corrections require structural fixes.** Invoke `/retrospective` for durable fixes (hooks, skills), not just memories.

## Key Workflows (via skills)

- **`/orchestrate`** — Full task lifecycle: selection, session, subagent dispatch, review, merge, completion
- **`/implement-task`** — Implementation within a session: spec verification, coding, testing, PR creation
- **`/review-pr`** — PR review with codebase verification, posted to GitHub. Required before any merge.
- **`/create-task`** — Task creation with structured spec (Summary, Success Criteria, Scope, Acceptance Tests)

## MCP Tools

Use MCP tools for all operations — never shell out to git/gh CLI:

- `mcp__minsky__tasks_*` — task CRUD, status, specs, deps
- `mcp__minsky__session_*` — session lifecycle, PRs, file operations
- `mcp__minsky__rules_*` — project rules
- `mcp__minsky__persistence_*` — database operations

**Use `session_exec` for running commands in sessions** from the main agent context. Instead of `SESSION=... && cd "$SESSION" && <command>`, use the MCP tool: `mcp__minsky__session_exec(task: "mt#123", command: "git status")`. This resolves the session directory automatically.

## Build & Test

- **Runtime**: Bun (not Node.js)
- **Type checking**: Automated by hooks (`tsgo`). Use `mcp__minsky__validate_typecheck` for explicit checks. **Never run `bun run tsc` manually.**
- **Lint**: Automated by hooks. Use `mcp__minsky__validate_lint` for explicit checks.
- **Tests**: `bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain`
- **Format**: `bun run format:check` / `bun run format:all`
- **All checks**: `bun run validate-all`

## Hook Files

All `.claude/hooks/*.ts` files must have execute permission (`chmod +x`). The `Write` tool creates `644` by default. Pre-commit hook enforces this.

## Code Style

- TypeScript strict mode, double quotes, 2-space indent, 100-char line width
- ES5 trailing commas, LF line endings
- Prefer template literals over string concatenation
- Max 400 lines per file (warn), 1500 (error)
- 10 custom ESLint rules enforce architectural patterns

## Compact Instructions

When compacting, preserve: current task ID and session path, file paths being edited, architectural decisions made this session, test failure details, and the current plan. Drop: full tool outputs (keep summaries), resolved debugging steps, verbose error messages already fixed.

## Key Architecture

- Clean architecture: Domain → Adapters → Infrastructure
- Shared command registry: commands defined once, adapted to CLI and MCP
- Capability-based persistence providers (ADR-002)
- Multi-backend tasks: GitHub Issues, Minsky DB
- Dependency injection via tsyringe (`docs/architecture.md` §6)
