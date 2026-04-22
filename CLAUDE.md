# Minsky — Claude Code Instructions

## Design Principle: Humility

A Minsky agent knows its boundary of delegation and represents it structurally, rather than collapsing uncertainty into confident action. Preference-bound decisions — naming, framework choice, tradeoff resolution, scope change, architectural novelty — are not yours to make alone; surface them to the user. Full framing: `docs/theory-of-operation.md §Companion Principles` and mt#1034.

Operational corollaries already in force below are instances of this one principle, not separate rules:

- 2-strikes escalation (§Error Investigation)
- User decides scope; never defer identified work (§Work Completion)
- Trust the hooks; never bypass (§Hook Files)

## Subagent Routing

When spawning subagents, use the appropriate model and type:

**Models:** `"sonnet"` for bounded tasks (implementation, refactoring, search, committing). `"opus"` (default) for complex investigation, architectural design, multi-step reasoning. `"haiku"` for simple search/formatting. (Community guides often recommend `haiku` as the `CLAUDE_CODE_SUBAGENT_MODEL` default; Minsky uses `sonnet` because subagents run full implementation workflows — edit, commit, PR — not just search/format.)

**Types:** `"refactor"` for structural changes (built-in coherence verification). `"verify-completion"` for spec verification. `"reviewer"` for read-only PR review. `"Explore"` for codebase search. `"Plan"` for design. `"general-purpose"` as fallback.

**Capacity:** Subagents have limited context/tool budgets with no graceful degradation. Scope to 8–12 files per wave. Instruct to commit incrementally. For multi-phase work, use subtasks (`tasks_create` with `parent`). If a subagent returns incomplete work, check session `git diff`/`git status` and finish from main agent.

**Prompt generation:** Always use `mcp__minsky__session_generate_prompt` — never hand-craft prompts. It enforces correct sessionId, taskId, paths, scope bounds, and guard rails. Dispatch with `suggestedModel` and `suggestedSubagentType` from the result.

**Escalation to Opus:** The default model is Sonnet. When you recognize you're struggling — 2nd identical tool error from the same tool, architectural ambiguity you can't resolve, multi-file reasoning that isn't converging, or a task that requires deep investigation — spawn a subagent with `model: "opus"` to analyze the problem. Let Opus produce the plan or diagnosis, then continue executing with Sonnet. Don't persist on a problem that exceeds your current model's capability. (See §Error Investigation for the mechanical 2-strikes rule.)

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

## Error Investigation

- **2-strikes rule: after the 2nd identical tool error from the same tool, stop.** Do not retry. Read the tool's actual error message, diagnose the root cause (permission? stale input? upstream state?), and file a bug task if the error is systemic. Resume only once you understand why it failed. Counting attempts, not classifying the situation — it's a mechanical rule.
- **Workarounds are not fixes.** Switching to an alternative path/method without understanding the root cause may hide a systemic bug that breaks other users. If a workaround is needed to proceed, file the underlying bug task first.
- **When any MCP tool call returns an error, stop and investigate before the next attempt.** Even on the first occurrence, don't retry blindly — retry only with a hypothesis about what the error means.

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

GitHub MCP PR-write tools are banned by a PreToolUse hook (see mt#1030) because they bypass TokenProvider and produce silent identity drift. Use the Minsky equivalents:

- `mcp__github__create_pull_request` → `mcp__minsky__session_pr_create`
- `mcp__github__update_pull_request` → `mcp__minsky__session_pr_edit`
- `mcp__github__merge_pull_request` → `mcp__minsky__session_pr_merge`
- `mcp__github__pull_request_review_write` → `mcp__minsky__session_pr_review_submit`

Read-only GitHub tools (`get_*`, `list_*`, `search_*`, `pull_request_read`) remain available since identity doesn't matter for reads.

### Running commands in sessions

Use `mcp__minsky__session_exec` to run shell commands inside a session workspace from the main agent context. The session directory is resolved automatically — no need to look up paths or `cd` into directories.

```
mcp__minsky__session_exec(task: "mt#123", command: "git status")
mcp__minsky__session_exec(task: "mt#123", command: "bun test --preload ./tests/setup.ts --timeout=15000 src")
mcp__minsky__session_exec(task: "mt#123", command: "bun run format:check")
mcp__minsky__session_exec(task: "mt#123", command: "ls src/domain/")
```

Never substitute `git -C <session-path> <cmd>` or `SESSION=... && cd "$SESSION" && <cmd>` — use `session_exec`.

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
