---
name: orchestrate
description: >-
  Master workflow for Minsky task implementation: task selection, session creation,
  subagent dispatch, PR creation, review, merge, and task completion.
  Use when starting work on a task, implementing a feature, or managing the full
  development lifecycle. Triggers on "start working on", "implement task", "workflow".
user-invocable: true
---

# Orchestrate

Master workflow for implementing tasks in Minsky. Covers the full lifecycle from task selection through merge and completion.

## Arguments

Optional: task ID (e.g., `/orchestrate mt#123`). If omitted, lists available tasks first.

## Workflow Sequence

### 1. Task selection and status verification

- List available tasks: `mcp__minsky__tasks_list` (filter by `status: "TODO"`)
- Get task details: `mcp__minsky__tasks_get` with the task ID
- Read task spec: `mcp__minsky__tasks_spec_get` to understand requirements
- Verify task status: `mcp__minsky__tasks_status_get` — must be TODO or IN-PROGRESS

### 2. Session creation

**First check for existing sessions on this task:**

- `mcp__minsky__session_list` with `task: "<task-id>"` — returns sessions with their `status` and `liveness` (from mt#951)
- Interpret liveness before proceeding:
  - **`healthy`** (active commits within 30 min): Another agent is working on this task. **Do not proceed.** Report back to the user; do not dispatch a competing session.
  - **`idle`** (30 min – 2 hours inactive): Likely paused. Report back to the user and ask whether to wait, monitor, or force-recover. Do not dispatch without confirmation.
  - **`stale` / `orphaned`** (>2 hours inactive, no commits): Abandoned. Proceed with `session_start --recover true` (from mt#1044) to delete the stale session and create fresh.
  - **Status `MERGED` or `CLOSED`**: The previous session is terminal. Either delete it manually (`session_delete`) or pick a different task — `--recover` will not override this.
  - **No session**: Normal flow, just `session_start` without `recover`.

Then start the session:

- `mcp__minsky__session_start` with `task: "<task-id>"`, `repo: "https://github.com/edobry/minsky.git"` (add `recover: true` if recovering from a stale session)
- This automatically sets task status to IN-PROGRESS
- Note the session ID and directory path for subagent dispatch

**Running commands in sessions**: Use `mcp__minsky__session_exec(task, command)` to run shell commands in the session workspace from the main agent context (e.g., `git status`, `bun test`, `ls src/`). Don't reach for bash `git -C <session-path>`.

### 3. Pre-work assessment

Before dispatching implementation:

- **Check scope**: If the task has multiple phases, create subtasks first (`mcp__minsky__tasks_create` with `parent: "<task-id>"`). Each subtask gets its own session.
- **Check file overlap**: If launching parallel tasks, verify they don't edit the same files. Serialize or partition if they do.
- **Verify spec freshness**: Task specs may be stale. Verify file:line references against the current codebase before starting.

### 4. Implementation dispatch

Generate a subagent prompt: `mcp__minsky__session_generate_prompt` with:

- `task`: the task ID
- `type`: `"implementation"` (or `"refactor"`, `"cleanup"` as appropriate)
- `instructions`: specific guidance for the implementation

Dispatch the subagent with the generated prompt. The subagent will:

- Edit code in the session directory
- Commit using `mcp__minsky__session_commit`
- Create a PR using `mcp__minsky__session_pr_create`

### 5. Review

After the subagent creates a PR, review it using the `/review-pr` skill:

- Verify findings against the actual codebase
- Check spec criteria are met
- Post the review to GitHub

### 6. Merge

Only after review is posted and all checks pass:

- Wait for CI: `mcp__minsky__session_pr_checks` — all must be `completed` + `success`
- Merge: `mcp__minsky__session_pr_merge` with `task: "<task-id>"`
- The local workspace auto-pulls after merge (PostToolUse hook)

### 7. Task completion

- Re-read the task spec: `mcp__minsky__tasks_spec_get`
- **Execute acceptance tests** — don't just re-read criteria. If the spec says "query returns X", run the query. If an API setting was changed, read it back. If a tool was registered, call it. Action is not verification.
- Verify every success criterion was delivered by the merged PR, with evidence from the executed tests
- If scope was reduced, update the spec and create follow-up tasks
- Mark complete: `mcp__minsky__tasks_status_set` with `status: "DONE"`

## Error recovery

| Error                         | Recovery                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Session tools fail            | Fall back to git CLI with `git fetch origin main && git rebase origin/main` before pushing |
| Path resolution issue         | All file operations must use absolute paths under the session directory                    |
| File editing outside session  | Cancel edits, switch to session workspace                                                  |
| PR has merge conflicts        | Run `mcp__minsky__session_update` to rebase on latest main                                 |
| CI checks failing             | Investigate failures, fix in session, commit, push — do not merge with failing checks      |
| Subagent runs out of capacity | Check `git diff` and `git status` in session, finish commit/PR from main agent             |

## Key principles

- **All work goes through sessions.** Never edit the main workspace directly.
- **Subagents do the full workflow.** They edit, commit, and create PRs. The main agent reviews and merges.
- **Review before merge.** A review that isn't posted to GitHub isn't a review.
- **Spec defines completeness.** A PR merging is not the same as a task being complete.
- **Never merge with pending checks.** Wait for all CI checks to pass.
- **One session, one merge.** After a session's PR is merged, the session is frozen. Use subtasks for multi-phase work.
