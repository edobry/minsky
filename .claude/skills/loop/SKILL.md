---
name: loop
description: >-
  Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo).
  Omit the interval to let the model self-pace. When the user wants to set up
  a recurring task, poll for status, or run something repeatedly on an interval
  (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do
  NOT invoke for one-off tasks.
user-invocable: true
---

# Loop

Run a prompt or slash command on a recurring interval. Self-pacing when no interval is given.

## Triggers

This skill activates when the user wants recurring execution:

- "keep running X"
- "/loop 5m /foo"
- "check the deploy every 5 minutes"
- "keep babysitting PRs"
- "poll for status every N minutes"

Do NOT invoke for one-off tasks — those belong to the appropriate task skills.

## Arguments

- Optional interval: `5m`, `30s`, `1h`, etc. When omitted, the model self-paces based on context.
- Required prompt or command: what to run on each iteration.

Examples:

- `/loop 5m /review-pr mt#123` — review the PR every 5 minutes
- `/loop drive PR #922 to convergence` — self-paced loop driving a PR

## Dynamic mode

In Dynamic mode, the loop parses the user's prompt and runs it repeatedly until a
stopping condition is reached or the user cancels.

**Stopping conditions (checked each iteration):**

- The underlying command succeeds and signals completion
- The user explicitly cancels
- A terminal state is detected (merged PR, completed task)
- A configured max iteration count is reached

### Steps

0. **Preflight: check PR/task terminal state.** If the parsed prompt names PRs
   (`#NNN`, `PR NNN`) or task IDs (`mt#NNNN`, `md#NNN`), call
   `mcp__github__pull_request_read get` and/or `mcp__minsky__tasks_status_get`
   for each. If any PR is merged/closed or any task is DONE/CLOSED, surface the
   terminal state and STOP — do not iterate.

   **Bridge note:** this step is enforced structurally by the PreToolUse hook
   `.claude/hooks/loop-preflight-pr-merge-check.ts` (mt#1555). The hook fires
   before the Skill tool executes and blocks the call if any referenced PR/task
   is already terminal. This skill step documents the check so the behavior is
   visible to readers of the skill even when the hook is the active enforcement
   mechanism. The skill step remains for defense-in-depth if the hook is
   unavailable.

   **Override:** Set `MINSKY_FORCE_LOOP_TERMINAL=1` to bypass the check with
   an audit log line. Use only when iterating on a terminal item is intentional
   and acknowledged.

1. **Parse the prompt.** Extract the command or description to run on each iteration.
   Identify any PR numbers or task IDs for terminal-state monitoring.

2. **Run the first iteration.** Execute the extracted command.

3. **Check stopping conditions.** After each run:

   - Did the command signal success/completion?
   - Did a referenced PR/task reach a terminal state since the last check?
   - Has the max iteration count been reached?

4. **Wait the configured interval** (or self-pace based on context) before the next iteration.

5. **Iterate** (return to step 2) or stop if a stopping condition was met.

## Key principles

- **Never iterate on closed/merged PRs.** A PR that has been merged has no open branch to
  push to — continuing to iterate produces orphan commits and wastes agent time. Always check
  terminal state before the first iteration (step 0) and after each iteration (step 3).
- **Self-pacing default.** Without an explicit interval, use context to determine appropriate
  wait time (e.g., reviewer-bot latency, CI run time, deploy propagation time).
- **Stop conditions are mandatory.** A loop without at least one stopping condition is an
  infinite loop — always define when to stop before starting.

## Origin

The terminal-state preflight (step 0) was added after the 2026-05-01 incident where an agent
looped for ~6 hours after PR #922 was merged at 18:24Z, attributing bot silence to a webhook
miss without checking PR state. Orphan commit `1d683c925` was pushed to a closed branch. See
mt#1555 and `feedback_check_merge_before_data_loss.md` for the full incident record.
