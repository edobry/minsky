---
name: create-task
description: >-
  Create a new task with a properly structured spec. Takes task intent and
  generates a spec with required sections (Summary, Success Criteria, Scope,
  Acceptance Tests, Context) before calling tasks_create.
user-invocable: true
---

# Create Task

Create a new Minsky task with a properly structured specification. This skill ensures every task has measurable success criteria and acceptance tests.

## Arguments

Required: A description of what the task should accomplish. Can be a brief intent ("add retry logic to session start") or a detailed requirement.

Optional flags (included in the description):

- `--parent <taskId>` — set a parent task for subtask relationships
- `--tags <tag1,tag2>` — add tags for thematic batching
- `--backend <backend>` — specify task backend (default: minsky)

## Process

### 1. Analyze the intent

Read the user's description and identify:

- **What** needs to be done (the deliverable)
- **Why** it matters (the motivation — a bug, a missing feature, tech debt)
- **Where** in the codebase it applies (if known)

If the intent is vague, ask one clarifying question before proceeding.

### 2. Research the codebase

Before writing the spec, search the codebase to ground the spec in reality:

- Find the files/modules that will be affected
- Check for existing related work (similar tasks, prior attempts)
- Identify dependencies or blockers

This prevents specs that reference non-existent files or miss existing infrastructure.

### 3. Generate the structured spec

Write a spec with ALL required sections:

```markdown
## Summary

<1-3 sentences: what this task does and why>

## Success Criteria

- [ ] <Measurable criterion 1>
- [ ] <Measurable criterion 2>
- [ ] ...

## Scope

**In scope:** <what's included>
**Out of scope:** <what's explicitly excluded>

## Acceptance Tests

- <Concrete test 1: action -> expected result>
- <Concrete test 2: action -> expected result>
- ...

## Context

- <Relevant background, related tasks, prior art>
- <Links to code, issues, or documentation>
```

**Quality rules for each section:**

- **Summary:** Lead with the deliverable, not the problem. Include the "why."
- **Success Criteria:** Each item must be independently verifiable. Use checkboxes. Avoid "should work correctly" — specify what "correctly" means.
- **Scope:** Name specific things that are OUT of scope to prevent scope creep.
- **Acceptance Tests:** Each test is an action+assertion pair. Include happy path AND edge cases.
- **Context:** Link to related tasks, PRs, or code paths. Include grep patterns that should return zero/non-zero results after completion.

### 4. Create the task

Call `mcp__minsky__tasks_create` with:

- `title`: concise task title (under 80 chars)
- `spec`: the full structured spec from step 3

If `--parent`, `--tags`, or `--backend` were specified, include those parameters.

### 5. Confirm

Report the created task ID and a one-line summary to the user.

## Example

User: `/create-task add a --dry-run flag to the session delete command`

Result:

```
Title: Add --dry-run flag to session delete command

## Summary

Add a `--dry-run` flag to `minsky session delete` that shows what would be deleted without actually deleting. This prevents accidental session loss.

## Success Criteria

- [ ] `minsky session delete --dry-run <session>` prints session details and "would delete" message without deleting
- [ ] `minsky session delete <session>` (without --dry-run) behavior unchanged
- [ ] Flag registered in CLI help text
- [ ] MCP tool `session_delete` accepts `dryRun` parameter

## Scope

**In scope:** --dry-run flag, CLI + MCP parameter, output formatting
**Out of scope:** Interactive confirmation prompt (separate task), bulk delete

## Acceptance Tests

- Run `minsky session delete --dry-run <existing-session>`: prints details, session still exists after
- Run `minsky session delete --dry-run <nonexistent-session>`: error "session not found"
- Run `minsky session delete <session>`: deletes normally (regression check)

## Context

- Session delete is in `src/adapters/shared/commands/session/lifecycle-commands.ts`
- Related: mt#687 (session lifecycle improvements)
```
