---
name: implement-task
description: >-
  Full implementation lifecycle for a Minsky task: read spec, plan, code, test,
  verify, commit, and create PR. All work happens in session workspaces with
  absolute paths. Use when implementing a task, starting development, or
  beginning work in a session.
user-invocable: true
---

# Implement Task

Step-by-step implementation lifecycle for a task within a Minsky session. Covers status-gating, session creation through PR creation.

**Owned lifecycle transitions:**

- READY → IN-PROGRESS: this skill owns this transition via `session_start`
- IN-PROGRESS → IN-REVIEW: this skill owns this transition via `session_pr_create`

## Triggers

This skill activates on: "implement mt#X", "start coding mt#X", "build mt#X", "start working on mt#X".

These triggers are intentionally READY-state verbs — the skill guards against acting on tasks that are not yet READY.

## Arguments

Optional: task ID (e.g., `/implement-task mt#123`). If omitted, uses the current session's task.

## Process

### 0. Entry gate: check task status

**This is the first and mandatory mechanical step.** Call `mcp__minsky__tasks_status_get` with the task ID.

Evaluate the returned status:

- **TODO or PLANNING** → halt immediately. Do NOT call `session_start`. Respond:
  > "Task mt#X is in `<STATUS>` state. Run `/plan-task mt#X` first to bring it to READY before implementing."
- **BLOCKED or CLOSED** → halt. Explain the status and ask the user how to proceed.
- **READY** → proceed to step 1 below. This skill owns the READY → IN-PROGRESS transition.
- **IN-PROGRESS** → a session may already exist. Retrieve it with `mcp__minsky__session_get` and continue from step 3.
- **IN-REVIEW** → PR already created. Remind user to use `/verify-task mt#X` for next steps.
- **DONE** → task is complete. No action needed.

### 0a. Late parallel-work spot-check

The PLANNING → READY gate already ran the full parallel-work check (`/plan-task` gate
criterion g). But READY → IN-PROGRESS may happen hours or days later, and new PRs may
have landed in the gap. Re-run an abbreviated check before `session_start`:

1. **Open-PR sweep** — `mcp__github__list_pull_requests` with `state: "open"`. Scan titles
   and branches for any PR whose scope plausibly overlaps the spec's `## Scope` → `In scope`
   files. Spot-check suspicious matches with `mcp__github__pull_request_read get_diff`.
2. **Recently-merged sweep** — `mcp__minsky__git_log` for the last 24 hours; check for any
   merge that touched files this task plans to modify. A fix that landed overnight is just
   as bad as one in flight.

If either sweep hits, **halt before `session_start`** and surface the finding to the user
(task ID or PR number, file overlap, recommendation: wait / coordinate / reframe / proceed
with explicit acknowledgment).

This is the last-line enforcement of `feedback_check_parallel_work_before_decomposing`.
The full gate ran at PLANNING; this is the spot-check before the session is created.

### 1. Retrieve relevant memory context

Call `memory_search` with the task ID and domain area:

- Query: e.g., `"mt#<id>"` or the feature area (e.g., `"session liveness"`, `"compile pipeline"`)
- Review any returned memories for prior decisions, user preferences, or architectural constraints
- This replaces the always-loaded MEMORY.md preamble — context is fetched on-demand

### 2. Read and verify the task spec

- Fetch the spec: `mcp__minsky__tasks_spec_get` with the task ID
- Read every success criterion and acceptance test
- **Verify spec freshness**: Specs may be stale from prior conversations. Check file:line references against the current codebase before starting.
- Never proceed based on title/database info alone — the full spec is required

### 3. Start a session (READY → IN-PROGRESS)

**This step owns the READY → IN-PROGRESS transition.**

Call `mcp__minsky__session_start` with the task ID. This:

- Creates an isolated session workspace
- Sets task status to IN-PROGRESS

All subsequent file operations must use absolute paths under the session directory returned by `session_start`.

### 4. Understand architectural context

Before writing any code:

- Investigate relevant architectural patterns in the codebase
- Search for documentation about systems being modified
- Understand integration points and workspace routing
- Research unfamiliar concepts mentioned in the spec

### 5. Plan the implementation

- Identify files to modify
- Sketch the changes
- Identify dependencies and potential issues
- Check relevant rules (architecture, testing, code quality)
- Update the task spec with the implementation plan

### 6. Develop

- Make code changes following project coding standards
- Add tests for new functionality
- Commit regularly with `mcp__minsky__session_commit`:
  - Use meaningful messages referencing the task ID
  - Group related changes in logical commits
- All file edits must use absolute paths under the session directory
- **Run commands in the session** using `mcp__minsky__session_exec(task: "mt#<id>", command: "<cmd>")` — e.g., `bun test`, `bun run format:check`, `git status`. Never use `git -C <path>` or shell `cd` workarounds.

### 7. Verify implementation

Before declaring complete:

- **Verify outcomes, not actions.** Never treat a command succeeding (exit 0, API 200) as proof the desired effect occurred. Read back the result: query the setting you changed, count rows after a migration, call the tool you registered.
- If the task spec has acceptance tests, **execute them** — don't just re-read the spec
- Verify rule compliance (architecture, testing, code quality rules)

### 8. Create PR (IN-PROGRESS → IN-REVIEW)

**This step owns the IN-PROGRESS → IN-REVIEW transition.**

Use `mcp__minsky__session_pr_create` to create the pull request:

- Title is description-only (no conventional commit prefix, no task ID)
- Body includes Summary, Key Changes, Testing sections
- The tool automatically rebases on main and sets task status to IN-REVIEW

### 9. Hand off to verify

After PR creation, **stop working on the session**. Do not continue committing.

Suggest to the user:

> "PR created. Run `/verify-task mt#X` to verify the implementation against all success criteria before merging."

**Do NOT** auto-run `/verify-task`, do NOT attempt to merge. Verification and merge are owned by the `/verify-task` skill and the review process.

## Constraints

These constraints apply throughout implementation:

- **Absolute paths only.** Every file operation must use the full session path (e.g., `/Users/edobry/.local/state/minsky/sessions/<id>/src/...`). Relative paths may resolve against the main workspace.
- **Never edit main workspace.** All changes happen in the session. If a bug is found in the main project, create a separate task for it.
- **Never manually set DONE.** Task status flows: TODO → IN-PROGRESS → IN-REVIEW → DONE. DONE is only set after PR merge, never manually from a session.
- **No work without a session.** Implementation work requires an active session for isolation and traceability.
- **Never bypass the entry gate.** Calling `session_start` on a TODO or PLANNING task skips the planning phase and produces unplanned implementation work.

## Key principles

- **Spec defines scope.** Don't add features or refactor beyond what the spec asks for.
- **The entry gate protects quality.** A task that isn't READY has not been planned. Don't implement unplanned work.
- **Commit incrementally.** Don't save everything for one final commit.
- **Document findings in the spec.** Update the task spec with progress, decisions, and verification outcomes — never create separate summary files.
