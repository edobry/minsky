import { defineSkill } from "../../../src/domain/definitions/factories";

export default defineSkill({
  name: "verify-task",
  description:
    'Set DONE on the bypass-merge fallback path: confirm the PR is merged AND the merge-commit body contains the canonical bypass-merge audit-trail signature, then transition IN-REVIEW → DONE. The reviewer subagent (in /review-pr) does the verification work; this skill only confirms the closeout signal. Use when: "verify mt#X", "check mt#X is done", "close out mt#X", "audit mt#X".',
  userInvocable: true,
  content: `
# Verify Task

Thin closeout wrapper for the bypass-merge fallback path. Owns the IN-REVIEW → DONE transition by confirming the PR is merged and carries the canonical bypass-merge audit-trail signature in its merge commit. **Does NOT re-verify the spec** — that work happens at review time inside \`/review-pr\` (which dispatches the reviewer subagent for spec verification + adoption sweep + smoke test). When the PR is merged via \`session_pr_merge\`, that tool atomically sets the task to DONE and this skill never fires; this skill only fires on the bypass-merge path where \`session_pr_merge\` wasn't used.

## Arguments

Required: task ID (e.g., \`/verify-task mt#123\`).

## Triggers

This skill activates on:

- "verify mt#X"
- "check mt#X is done"
- "close out mt#X"
- "audit mt#X"

These are IN-REVIEW-state verbs. Do NOT invoke this skill for tasks that are still being implemented or reviewed — use \`/implement-task\` or \`/review-pr\` instead.

## Process

### 1. Check task status (entry gate)

Call \`mcp__minsky__tasks_status_get\` with the task ID.

- **If status is IN-REVIEW**: Proceed to step 2.
- **If status is IN-PROGRESS**: Halt. Surface:
  > Task mt#X is still IN-PROGRESS. The implementation is not yet ready for closeout.
  > Use \`/implement-task mt#X\` to complete the implementation and create a PR first.
- **If status is READY**: Halt. Surface:
  > Task mt#X is READY but has not been reviewed yet.
  > Use \`/review-pr\` to review the PR, then merge.
- **If status is TODO or PLANNING**: Halt. Surface:
  > Task mt#X is in \${status} state — far too early to close out.
  > Use \`/implement-task mt#X\` to begin implementation.
- **If status is DONE**: Halt (already complete). Surface:
  > Task mt#X is already DONE.
- **If status is BLOCKED or CLOSED**: Halt. Surface the current status and reason.

### 2. Locate the PR

Find the PR for the task. Typical resolution paths:

- \`mcp__minsky__session_get(task: "mt#X")\` returns the session record, which carries the PR number.
- If no session record carries it, search by branch name pattern (\`task/mt-<id>\`) via \`mcp__github__list_pull_requests\`. Query both \`state: "open"\` and \`state: "closed"\` — \`/verify-task\` may fire just after merge but before GitHub finishes marking the PR closed, or on a still-open PR that bypass-merged via a separate path. Trying \`state: "all"\` (or open + closed in sequence) ensures the PR is found regardless of where it sits in that race window.

Call \`mcp__github__pull_request_read\` with \`method: "get"\` to retrieve PR metadata. If no PR is found:

> Task mt#X is at IN-REVIEW status but no PR was found. Either the PR was created outside the standard flow, or there is a state inconsistency. Investigate before retrying.

### 3. Confirm closeout signal

The closeout signal has TWO conditions — both must be true:

**Condition A: \`pr.merged === true\`.**

The PR is merged. If \`pr.merged === false\`, halt and surface:

> Task mt#X is at IN-REVIEW with PR #N still open (not merged). The task should not be closed out before the PR is merged. Investigate the inconsistency.

**Condition B: The merge-commit body contains the canonical bypass-merge audit-trail signature.**

Fetch the merge commit via \`mcp__github__get_commit(owner, repo, sha: pr.merge_commit_sha)\` and grep the commit message for the literal phrase:

\`\`\`
Bot self-approval bypass per feedback_self_authored_pr_merge_constraints
\`\`\`

This phrase is the canonical audit trail used in bypass-merges across the project (PR #886, PR #933 confirmed as of 2026-05-01). If the phrase is absent, **halt unconditionally** — DONE is not allowed without both conditions. Branch on which path the PR took only to inform the surfacing message, not to allow proceeding:

- **If the PR was merged via \`session_pr_merge\`:** that tool already auto-set the task to DONE in the same atomic operation (see \`src/domain/session/session-merge-operations.ts:519-544\`). This skill should not have fired. Confirm the task status is actually IN-REVIEW; if it is, surface the inconsistency for investigation. **Do not set DONE.**
- **If the PR was merged via the GitHub UI directly or via \`gh api\` without the audit phrase:** halt and surface:
  > PR #N was merged but the merge-commit body lacks the canonical bypass-merge audit-trail signature (\`Bot self-approval bypass per feedback_self_authored_pr_merge_constraints\`). The bypass-merge path requires the audit trail to be auditable. **Task remains at IN-REVIEW.** Recovery: amend the bypass-merge process to include the audit phrase next time, OR file a follow-up issue documenting why this merge bypassed the audit discipline (which is itself the audit trail for _this_ particular merge), then manually set DONE only after the user has reviewed the documented exception.

In either case, **this skill does not set DONE.** The \`Never set DONE without both conditions\` key principle is strict; the missing-phrase branch surfaces the gap and stops.

If both conditions A and B are satisfied, proceed to step 4.

### 4. Set DONE

Call \`mcp__minsky__tasks_status_set\` to transition the task to DONE.

Confirm with \`mcp__minsky__tasks_status_get\` that the status is actually DONE (status writes are the kind of state mutation worth reading back per \`feedback_state_mutations_need_verifiable_receipts\`).

Surface:

> Task mt#X is now DONE.
>
> Closeout signal:
>
> - PR #N merged (commit \`<sha>\`)
> - Audit trail present in merge commit body
>
> The reviewer subagent's review and the merge-commit audit message are the verification artifacts.

## Why no auditor dispatch?

The reviewer subagent (in \`.claude/agents/reviewer.md\` Mode 2, dispatched by \`/review-pr\` and auto-firing \`minsky-reviewer[bot]\`) already verifies spec criteria + adoption sweep + smoke test at review time, against the PR branch. By the time the bypass-merge happens, all verification work has been done; the merge-commit audit trail names the substantive fixes that landed and any deferred items.

Re-dispatching the auditor post-merge against local main produced a stale-source false-FAIL bug on 2026-05-01 (mt#1485). Dropping the auditor dispatch retires that surface entirely. The architectural decision (option B from the 2026-05-01 design discussion) is captured in mt#1551.

For ad-hoc spec verification (e.g., one-off audit of a long-DONE task, second-opinion verification, non-PR audits), invoke the \`auditor\` subagent directly — \`.claude/agents/auditor.md\` is still available; it just isn't this skill's default surface.

## Key principles

- **The reviewer subagent does the verification.** This skill only confirms the closeout signal.
- **Bypass-merge audit trail is load-bearing.** Without the canonical phrase, the bypass is indistinguishable from a merge that skipped review.
- **Never set DONE without both conditions.** The merge alone is not enough; the audit trail must also be present.
- **Never modify the task spec.** Spec edits are the implementer's job, not the closeout's.
- **\`session_pr_merge\` is the canonical merge path.** When it runs, it atomically sets DONE and this skill never fires; this skill is the fallback for the bypass-merge path only.
- **Concurrent-merge regression detection is out of scope here.** The pre-merge smoke (folded into \`/review-pr\`) catches PR-introduced regressions; concurrent-merge interactions are a separate concern tracked in mt#1592.
`,
});
