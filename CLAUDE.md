# Minsky — Claude Code Instructions

## Subagent Model Routing

When spawning subagents via the Agent tool, use the appropriate model to balance capability with rate limit consumption:

- **`model: "sonnet"`** — Well-defined implementation tasks: applying known fixes, editing specific lines, running tests, committing, file exploration, search, any task with clear instructions and bounded scope.
- **`model: "opus"` (default)** — Complex bug investigation, architectural design and review, multi-step reasoning across many files, tasks where the approach isn't yet clear.

### Subagent Type Routing

Prefer specialized subagent types over `general-purpose` when one fits:

- **`subagent_type: "refactor"`** — Structural code changes (renaming, moving, eliminating layers, consolidating, extracting). Has built-in coherence verification: re-reads modified files end-to-end and reports stale comments, redundant siblings, dead exports, and orphan code. Use whenever the task is a refactor rather than feature work. _Why_: relying on a remembered "verify the result is coherent" rule is structurally weak; the verification belongs in the agent's identity, not in your prompt.
- **`subagent_type: "verify-completion"`** — Task completion verification. Reads the task spec, checks each success criterion against the current codebase, returns structured pass/fail. Use before marking any task DONE. _Why_: the doer is biased toward "I did what was asked." A fresh agent objectively evaluates completion.
- **`subagent_type: "reviewer"`** — Read-only PR review analysis. Reads a section of diff, verifies each change against actual source files, reports structured findings (blocking/non-blocking). Dispatched by `/review-pr` for large PRs (~25 files per agent). Cannot modify code. _Why_: reviews require reading 100% of the diff — reviewer agents enable parallel coverage without blowing the main context.
- **`subagent_type: "Explore"`** — Codebase exploration and search.
- **`subagent_type: "Plan"`** — Designing implementation plans before coding.
- **`subagent_type: "general-purpose"`** — Fallback for work that doesn't fit a specialized type.

### Subagent Capacity

Subagents have limited tool-call budgets and context windows. They cannot detect when they're approaching limits and get no cleanup chance when cut off. Uncommitted work is lost.

- **Scope subagent work to fit within capacity.** A subagent touching 15+ files is at risk. For large refactors, split into waves of 8–12 files each.
- **Instruct subagents to commit incrementally**, not in one final commit. The refactor subagent already has this in its system prompt.
- **If a subagent returns incomplete work** (changes applied but not committed/PR'd), check the session's `git diff` and `git status`, then finish the commit/PR from the main agent.
- **For multi-phase work, use subtasks.** If a subagent completes Phase 1 and there's remaining work, create a subtask for the next phase (`tasks_create` with `parent: "<task-id>"`). Each subtask gets its own session and PR. Do NOT reuse the same session or do delete-restart.
- **Pre-decompose large tasks** before farming them out. If a task clearly has multiple phases, create subtasks upfront and dispatch each to its own subagent with its own session.
- **For cascading changes** (where editing one file forces changes in its callers), the blast radius is unpredictable. Err on the side of smaller scope and let the cascade determine one wave's natural boundary.

### Subagent Prompt Generation

**Always use `session.generate_prompt`** to generate subagent prompts instead of hand-crafting them. The tool ensures correct sessionId, taskId, absolute paths, scope bounds, and guard rails — eliminating the class of failures seen in mt#672 (wrong task IDs, missing sessionIds, unbounded scope).

**Workflow:**

1. **Assess scope**: If the task has multiple phases, create subtasks first (`tasks_create` with `parent`). Each subtask gets its own session.
2. Start a session: `mcp__minsky__session_start` (for the task or subtask)
3. Generate the prompt: `mcp__minsky__session_generate_prompt` with `task`, `type`, and `instructions`
4. Dispatch: pass the returned `prompt` string to the Agent tool, using `suggestedModel` and `suggestedSubagentType` from the result
5. Review and merge as normal

**Prompt types:**

- `implementation` — Feature work with commit + PR instructions
- `refactor` — Structural changes, suggests `subagent_type: "refactor"`
- `review` — Read-only, no commit/PR instructions
- `cleanup` — Mechanical fixes with batching guidance
- `audit` — Post-merge spec verification, suggests `subagent_type: "verify-completion"`

**Scope batching:** When `scope` has > 40 files, the tool returns multiple prompts in the `batches` array (~30 files each). Dispatch each batch as a separate subagent with intermediate commits.

**Do NOT hand-craft subagent prompts.** The tool handles session resolution, metadata injection, guard rails, and scope validation. Hand-crafting bypasses these safety mechanisms.

## Minsky Session Workflow

Minsky sessions are isolated git clones at `~/.local/state/minsky/sessions/<UUID>/` (branch names follow `task/<backend>-<id>` format). The correct working pattern:

1. **ALL work goes through sessions** — even small fixes. Never edit main workspace directly.
2. **Main agent** orchestrates: create tasks, start sessions, launch subagents, review PRs, merge.
3. **Subagents** do the full workflow in session directories: edit code → `mcp__minsky__session_commit` → `mcp__minsky__session_pr_create`. They do NOT merge — that happens after review.
4. **Before creating a PR**, always ensure the session is up-to-date with main. `mcp__minsky__session_pr_create` automatically calls `session_update` (which rebases the session on latest main) before creating the PR — this prevents merge-induced formatting drift and ensures clean fast-forward merges. You can also call `mcp__minsky__session_update` explicitly before committing if needed.
5. **Main agent reviews** the PR using the `/review-pr` skill, which verifies findings against the actual codebase and posts the review to GitHub. Never merge without a posted GitHub review.
6. **After merging a PR**, the local workspace is stale (merge happens on GitHub). A PostToolUse hook auto-pulls after `session_pr_merge`. If starting a fresh conversation after prior merges, verify the workspace is current before analyzing code.
7. **When merging multiple PRs sequentially**, each merge may cause conflicts in remaining PRs. Update remaining sessions (`session_update`) after each merge, or resolve conflicts with `session_search_replace` on the conflict markers.
8. All file operations in sessions MUST use absolute paths.
9. **NEVER use `skipInstall: true`** when starting sessions. Sessions without `node_modules` cannot pass typecheck hooks, blocking subagent completion. Always let deps install.
10. **NEVER use bare git CLI** (`git add`, `git commit`, `git push`, `git pull`, `git -C`). Always use MCP tools. Shell `#` in task paths causes parsing issues and permission prompts.
11. **Always quote all Bash arguments** containing `#`, `$`, or special chars if Bash is unavoidable.
12. **If MCP session tools fail** (e.g., mt#722 causes session records to vanish), and you must fall back to bare git for commit/push/PR creation, you MUST replicate the safety steps that the MCP tools would have performed: `git fetch origin main && git rebase origin/main` before pushing, to prevent merge conflicts that block CI. A PR with conflicts will not trigger CI — GitHub silently skips it.

### Session lifecycle: one session, one merge

After a session's PR is merged, the session is **frozen** — write operations (`session_pr_create`, `session_pr_edit`, `session_commit`, `session_pr_approve`, `session_update`) will refuse. Read operations still work.

For multi-phase work, **use subtasks** — each phase gets its own task, session, and PR:

```
mcp__minsky__tasks_create (title: "Next phase", parent: "<parent-task-id>")
mcp__minsky__session_start (task: "<new-subtask-id>")
```

This preserves the 1:1 task↔session invariant while giving each phase its own identity, spec, and status tracking. The parent task tracks progress across subtasks.

**Do NOT use the delete-restart pattern** (`session_delete` → `session_start` on the same task). That is an anti-pattern — it loses context, wastes time on re-cloning, and risks branch collisions. Subtasks are the correct decomposition.

### Parallel Task Planning

When launching multiple subagents in parallel, **check for file overlap** between tasks before starting. If two tasks will edit the same file, either:

- Serialize them (run one after the other)
- Explicitly scope each task to skip the shared file
- Partition by file set rather than by pattern category

Merging parallel PRs that touch the same files causes cascading conflicts that require session recreation.

### Removal and Deletion PRs

When a PR removes a feature, module, or backend, symbol-level grep ("is the deleted class still imported?") is necessary but **not sufficient**. Code that _serves_ removed functionality often lives in other files without importing the removed module.

**Behavioral residue search** — required before declaring any removal PR complete:

1. **Hardcoded paths/filenames** associated with the removed feature (e.g., `process/tasks.md`, `session-db.json`)
2. **Concept-name strings** in comments, descriptions, error messages, and docs (e.g., `"markdown"`, `"json-file"`)
3. **Interface fields** that only make sense with the removed feature (e.g., `sessionDbPath`)
4. **Inline code blocks** that manipulate data in the removed format (e.g., parsing markdown task lists in a shared service)
5. **Utility functions** in shared modules that only served the removed feature
6. **Documentation sections** describing removed behavior

**Subagent instructions for partial removal**: Never use "if shared, leave it." Always: "if shared, identify which exports/functions are dead and refactor to keep only the live parts."

**Task specs for removals** must include a behavioral scope section listing concepts/behaviors being removed, not just files. Include grep patterns that should return zero results after the work is done.

## PR Reviews

**Always use the `/review-pr` skill when reviewing any PR.** This includes "review PR #X", "check this PR", "look at the diff", or reviewing after subagent work. A review that isn't posted to GitHub is not a review.

## Task Lifecycle

```
TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE
       (investigate) (gate)  (session_start) (pr_create)  (verify + merge)

Also: BLOCKED (from PLANNING, READY, or IN-PROGRESS), CLOSED (from any state)
```

**Status transitions are enforced in the domain layer.** Invalid transitions are rejected with descriptive errors listing valid transitions from the current state.

- **TODO → PLANNING**: Agent picks up the task. Set status to PLANNING before any investigation or session work.
- **PLANNING** (no session): Read and verify the spec (pre-flight). Investigate the codebase if needed. Persist findings to the spec. No session exists — no code changes yet.
- **PLANNING → READY**: Agent declares planning complete. Set status to READY when investigation is done and spec is up to date.
- **READY → IN-PROGRESS**: Only via `session_start` (cannot be set directly). `session_start` blocks from TODO and PLANNING.
- **IN-PROGRESS → IN-REVIEW**: PR created.
- **IN-REVIEW → DONE**: Spec verified, PR merged.
- **IN-PROGRESS → PLANNING**: Go back for more investigation if scope was wrong.
- **READY → PLANNING**: Go back if more investigation is needed before starting.

## Task Completion Protocol

A PR merging is NOT the same as a task being complete. Before marking any task DONE:

1. **Re-read the task spec** — fetch it with `tasks_spec_get` and review every success criterion
2. **Check each criterion** — verify the PR/code actually delivers it, not just something adjacent
3. **If scope was reduced**, update the spec FIRST to reflect actual scope, note what was deferred, and create follow-up tasks for gaps before marking DONE
4. **If criteria can't be verified**, the task is not DONE — use IN-REVIEW or create follow-up tasks

Never treat "code merged" as equivalent to "task complete." The spec defines completeness, not the PR.

### PLANNING phase: Pre-flight and investigation

During PLANNING (before `session_start`):

1. Fetch the task spec with `tasks_spec_get` and verify against the **current** codebase
2. If items are already done or no longer applicable, update the spec before starting work
3. If investigation/audit is needed, do it now and persist findings to the spec **before** presenting in chat. Chat is volatile — session termination loses all findings. The spec is the durable artifact.
4. Update the task spec with findings (`tasks_edit` with `specContent`) — include file paths, line numbers, and rationale
5. Mark completed criteria (e.g., `[x] Audit completed`)
6. When ready, call `session_start` to transition to IN-PROGRESS

### Spec verification and documentation impact gate merge

The `/review-pr` skill requires both a **Spec verification** section and a **Documentation impact** section in every review. The pre-merge hook (`require-review-before-merge.ts`) blocks merges if either section is missing. This ensures:

- Every spec criterion is checked before merge
- Scope reductions are caught and documented
- Follow-up tasks are created for deferred work
- Documentation freshness is assessed for every PR — if docs need updating, the update must be in the same PR (not deferred to a follow-up)

## Work Completion

- **Do not defer identified, actionable work.** If the current task's success criteria have unmet items and the work to address them is known (not blocked, not requiring new research), complete it. Do not create follow-up tasks, update specs to reduce scope, or propose partial PRs without explicitly asking the user.
- **The user decides scope, not the agent.** Never unilaterally decide "this is a good stopping point." If uncertain whether to continue, ask.
- **Artifact creation is not progress.** Creating tasks, updating specs, writing rules, and process discussion are not substitutes for doing the work. If you can describe exactly what needs to be done, do it.
- **Before proposing to ship**, check the task spec's success criteria. If items are unmet and actionable, keep working.
- **Never notice an issue without acting on it.** If you discover a problem, duplication, or architectural concern that's out of scope to fix now, immediately file a task with `mcp__minsky__tasks_create`. Mentioning it in chat is not action — it must become a trackable artifact (task, spec update, or memory). There is no "worth noting for a follow-up" without creating the follow-up.
- **Process corrections require structural fixes, not memories.** When corrected on a process failure, invoke `/retrospective` to analyze the root cause and produce durable fixes (hooks, skill updates, CLAUDE.md changes). Saving a memory is not enforcement — memories are behavioral guidance that can be ignored. Hooks and skill steps are structural and cannot be bypassed.

## Task Creation

**Always use the `/create-task` skill when creating tasks.** This ensures every task has a structured spec with required sections (Summary, Success Criteria, Scope, Acceptance Tests, Context). A PostToolUse hook on `tasks_create` blocks creation if specs over 100 chars are missing `## Success Criteria` or `## Acceptance Tests`.

## MCP Tools

Minsky exposes 80+ MCP tools. Use them for all task and session operations instead of shelling out to the CLI:

- `mcp__minsky__tasks_*` — task CRUD, status, specs, deps
- `mcp__minsky__session_*` — session lifecycle, PRs, file operations
- `mcp__minsky__rules_*` — project rules
- `mcp__minsky__persistence_*` — database operations

## Build & Test

- **Runtime**: Bun (not Node.js)
- **Type checking**: Handled automatically by hooks (`tsgo` native compiler). PostToolUse hook runs after every edit; Stop hook blocks if errors remain. For explicit checks, use `mcp__minsky__validate_typecheck`. **Never run `bun run tsc` manually.**
- **Lint**: Handled automatically by hooks. For explicit checks, use `mcp__minsky__validate_lint`. **Never run `bun run lint` manually.**
- **Tests**: `bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain`
- **Format**: `bun run format:check` / `bun run format:all`
- **All checks**: `bun run validate-all`

## Hook Files

- **All `.claude/hooks/*.ts` files must have execute permission** (`chmod +x`). The `Write` tool creates files with `644` by default — always run `chmod +x` after creating a hook file.
- The pre-commit hook enforces this: commits with non-executable hook files are rejected.

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
- Multi-backend tasks: GitHub Issues, Minsky DB
- Dependency injection via tsyringe (`docs/architecture.md` §6)
