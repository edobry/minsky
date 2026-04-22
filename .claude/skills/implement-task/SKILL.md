---
name: implement-task
description: >-
  Full implementation lifecycle for a Minsky task: read spec, plan, code, test,
  verify, commit, and create PR. All work happens in session workspaces with
  absolute paths. Use when implementing a task, starting development, or beginning
  work in a session.
user-invocable: true
---

# Implement Task

Step-by-step implementation lifecycle for a task within a Minsky session. Covers everything from reading the spec through creating the PR.

## Arguments

Optional: task ID (e.g., `/implement-task mt#123`). If omitted, uses the current session's task.

## Prerequisites

- A session must be started (`mcp__minsky__session_start`)
- All file operations use absolute paths under the session directory
- Never edit the main workspace during implementation

## Process

### 1. Read and verify the task spec

- Fetch the spec: `mcp__minsky__tasks_spec_get` with the task ID
- Read every success criterion and acceptance test
- **Verify spec freshness**: Specs may be stale from prior conversations. Check file:line references against the current codebase before starting.
- Never proceed based on title/database info alone — the full spec is required

### 2. Understand architectural context

Before writing any code:

- Investigate relevant architectural patterns in the codebase
- Search for documentation about systems being modified
- Understand integration points and workspace routing
- Research unfamiliar concepts mentioned in the spec

### 3. Plan the implementation

- Identify files to modify
- Sketch the changes
- Identify dependencies and potential issues
- Check relevant rules (architecture, testing, code quality)
- Update the task spec with the implementation plan

### 4. Develop

- Make code changes following project coding standards
- Add tests for new functionality
- Commit regularly with `mcp__minsky__session_commit`:
  - Use meaningful messages referencing the task ID
  - Group related changes in logical commits
- All file edits must use absolute paths under the session directory
- **Run commands in the session** using `mcp__minsky__session_exec(task: "mt#<id>", command: "<cmd>")` — e.g., `bun test`, `bun run format:check`, `git status`. Never use `git -C <path>` or shell `cd` workarounds.

### 5. Verify implementation

Before declaring complete:

- **Verify outcomes, not actions.** Never treat a command succeeding (exit 0, API 200) as proof the desired effect occurred. Read back the result: query the setting you changed, count rows after a migration, call the tool you registered.
- Run the `verify-completion` subagent to objectively check each success criterion
- If the task spec has acceptance tests, **execute them** — don't just re-read the spec
- Verify rule compliance (architecture, testing, code quality rules)

### 6. Create PR

Use the `/prepare-pr` skill or `mcp__minsky__session_pr_create` to create the pull request:

- Title is description-only (no conventional commit prefix, no task ID)
- Body includes Summary, Key Changes, Testing sections
- The tool automatically rebases on main and sets status to IN-REVIEW

### 7. Stop working on the session

After PR creation, the session's work is done. Do not continue committing. The main agent will review and merge.

## Constraints

These constraints apply throughout implementation:

- **Absolute paths only.** Every file operation must use the full session path (e.g., `/Users/edobry/.local/state/minsky/sessions/<id>/src/...`). Relative paths may resolve against the main workspace.
- **Never edit main workspace.** All changes happen in the session. If a bug is found in the main project, create a separate task for it.
- **Never manually set DONE.** Task status flows: TODO → IN-PROGRESS → IN-REVIEW → DONE. DONE is only set after PR merge, never manually from a session.
- **No work without a session.** Implementation work requires an active session for isolation and traceability.

## Key principles

- **Spec defines scope.** Don't add features or refactor beyond what the spec asks for.
- **Verify before declaring complete.** Use the verify-completion subagent — the doer should not verify their own work.
- **Commit incrementally.** Don't save everything for one final commit.
- **Document findings in the spec.** Update the task spec with progress, decisions, and verification outcomes — never create separate summary files.
