---
name: verify-task
description: >-
  Verify a task's acceptance tests, perform the post-merge adoption audit, and
  transition IN-REVIEW → DONE. Dispatches the verify-completion subagent for
  objective acceptance-test verification. Use when: "verify mt#X", "check mt#X
  is done", "close out mt#X", "audit mt#X".
user-invocable: true
---

# Verify Task

Own the IN-REVIEW → DONE lifecycle transition: run acceptance-test verification via the
`verify-completion` subagent, perform the post-merge adoption audit, and set DONE on pass.

## Arguments

Required: task ID (e.g., `/verify-task mt#123`).

## Triggers

This skill activates on:

- "verify mt#X"
- "check mt#X is done"
- "close out mt#X"
- "audit mt#X"

These are IN-REVIEW-state verbs. Do NOT invoke this skill for tasks that are still being
implemented or reviewed — use `/implement-task` or `/review-pr` instead.

## Process

### 1. Check task status (entry gate)

Call `mcp__minsky__tasks_status_get` with the task ID.

- **If status is IN-REVIEW**: Proceed to step 2.
- **If status is IN-PROGRESS**: Halt. Surface:
  > Task mt#X is still IN-PROGRESS. The implementation is not yet ready for verification.
  > Use `/implement-task mt#X` to complete the implementation and create a PR first.
- **If status is READY**: Halt. Surface:
  > Task mt#X is READY but has not been reviewed yet.
  > Use `/review-pr` to review the PR, then retry `/verify-task mt#X`.
- **If status is TODO or PLANNING**: Halt. Surface:
  > Task mt#X is in ${status} state — far too early to verify.
  > Use `/implement-task mt#X` to begin implementation.
- **If status is DONE**: Halt (already complete). Surface:
  > Task mt#X is already DONE.
- **If status is BLOCKED or CLOSED**: Halt. Surface the current status and reason.

### 2. Read the task spec

Call `mcp__minsky__tasks_spec_get` with the task ID. Extract:

- Every success criterion
- Every acceptance test
- Scope boundaries (what is explicitly out of scope)

This is the ground truth for step 3.

### 3. Dispatch `verify-completion` subagent

**Do not re-implement verification logic here.** Dispatch the existing `verify-completion`
subagent with the task ID. The subagent will:

1. Fetch the task spec
2. Extract every success criterion
3. Verify each criterion against the codebase with evidence (grep patterns, file existence, test output)
4. Run baseline checks: full test suite, type check, lint, E2E smoke test, doc staleness
5. Return a structured report with pass/fail verdicts per criterion

Dispatch using `subagent_type: "verify-completion"` and pass the task ID as input.

Wait for the subagent report before proceeding.

### 4. Evaluate verification result

Read the subagent's output report:

- **Overall PASS** (all criteria met, baseline checks pass): Proceed to step 5 (adoption audit).
- **Overall FAIL or PARTIAL**: Halt. Do NOT set DONE. Surface the failing criteria clearly:

  > Verification failed for mt#X. The following criteria are not met:
  >
  > - [Criterion N]: [evidence from subagent report]
  > - [Criterion M]: [evidence from subagent report]
  >
  > Task remains IN-REVIEW. Fix the unmet criteria and retry `/verify-task mt#X`.

  Stop here — do not proceed to adoption audit or DONE transition.

### 5. Post-merge adoption audit

Before marking DONE, sweep for consumers of any **new features** introduced by this task.

Per `feedback_adoption_check.md`: meeting spec criteria does not mean a feature is adopted.
A feature that has no callers, no tests that exercise the new path, or no documentation
pointing at it may be dead on arrival.

#### Adoption sweep procedure

For each new public API, command, MCP tool, or behavior change introduced by the task:

1. **Identify the export/entry point** — function name, CLI command, MCP tool name, event type, etc.
2. **Search for consumers** in the codebase:
   - `grep` for the function/tool name across `src/`, `tests/`, docs, CLAUDE.md, AGENTS.md
   - Check if any CLI commands call the new code path
   - Check if any existing tests exercise the new behavior
3. **Classify the finding**:
   - **Adopted**: at least one consumer exists (test, CLI integration, docs reference, calling code)
   - **Missing consumers**: no callers found

#### If missing consumers are found

File an adoption task:

```
mcp__minsky__tasks_create({
  title: "Wire consumers for <feature-name> (adoption follow-up for mt#X)",
  description: "Feature <feature-name> was implemented in mt#X but has no consumers yet. ...",
  status: "TODO"
})
```

Surface the finding:

> Adoption audit: <feature-name> has no consumers in the codebase.
> Filed follow-up task mt#Y to wire consumers.
> Proceeding to DONE — adoption gap is tracked.

Note: Missing consumers do NOT block DONE if the adoption task is filed. The spec defines
completeness; consumer wiring is a separate adoption concern tracked by the follow-up task.

#### If all new features have consumers

Surface confirmation:

> Adoption audit: all new features have at least one consumer. Proceeding to DONE.

### 6. Set task status to DONE

Call `mcp__minsky__tasks_status_set` with:

- `taskId`: the task ID
- `status`: "DONE"

Confirm the status change was applied by calling `mcp__minsky__tasks_status_get` and
verifying the returned status is "DONE".

Surface:

> Task mt#X is now DONE.
>
> Verification summary:
>
> - Criteria checked: X of X passed
> - Baseline checks: pass
> - Adoption audit: [summary]

## Key principles

- **The doer should not verify their own work.** This skill dispatches the `verify-completion`
  subagent, which brings an objective perspective.
- **Never set DONE on a FAIL verdict.** If any success criterion is unmet, the task stays
  IN-REVIEW. Surface the specific failing criteria — do not summarize vaguely.
- **Adoption check is non-blocking for DONE.** File the adoption task, then proceed. The spec
  defines completeness; consumer wiring is tracked separately.
- **Verify the status write.** After calling `tasks_status_set`, read back with
  `tasks_status_get` to confirm the transition actually occurred.
- **Do not modify the task spec.** Spec edits are the implementer's job, not the verifier's.
