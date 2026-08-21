/**
 * Decision: after a PR-create call returns, should the agent be reminded to
 * drive the PR to convergence rather than end the turn? (mt#1793)
 *
 * Lifted from `.minsky/hooks/drive-pr-to-convergence.ts` by mt#4374's first
 * extraction wave. That hook's `decideReminder` took a whole `ToolHookInput`
 * and performed its own tool-name match and `tool_result.success` read, which
 * fused payload parsing with the verdict. The split this module records:
 *
 *   - The RULE'S SUBJECT — which tool this is about, and that only a SUCCESSFUL
 *     creation warrants the reminder — is the decision, and lives here.
 *   - Getting `toolName` and `succeeded` OUT of a hook payload (absent
 *     `tool_result`, a non-object envelope, a truthy-but-not-`true` success
 *     field) is payload shape, and stays in the binding.
 *
 * So this function takes plain values and can be tested without constructing a
 * hook payload (mt#4374 AT2).
 *
 * ADR-026 tier 2: no dependencies, so no `deps` parameter — nothing to inject.
 * No `process.env` read, no filesystem access, no clock read.
 *
 * @see docs/architecture/adr-026-dependency-injection-convention.md — rule 2
 * @see decision-defaults.mdc §User does not review PRs in the loop
 * @see mt#4374 — the extraction wave
 */

/** The MCP tool whose successful result this rule is about. */
export const PR_CREATE_TOOL_NAME = "mcp__minsky__session_pr_create";

/**
 * What the decision needs to know about a PR-create tool call. Deliberately not
 * the hook payload type: `succeeded` is the binding's reading of the result
 * envelope, not the envelope itself.
 */
export interface PrConvergenceReminderInput {
  /** The tool that just returned. */
  toolName: string;
  /** Whether that call reported success. The binding decides what counts. */
  succeeded: boolean;
}

/**
 * The reminder injected into the agent's next context after `session_pr_create`
 * succeeds. The text encodes the discipline at three levels:
 *
 *   1. Required next action (positive): `session_pr_wait-for-review` with
 *      `minsky-reviewer[bot]`. On webhook-miss: empty commit wake, re-wait,
 *      then bypass merge.
 *   2. Forbidden behavior (negative): deferral language as turn-closing,
 *      and dispatching reviewer subagents.
 *   3. Reference to the corpus rules so the agent can re-read them on the
 *      next turn if context budget allows.
 */
export const DRIVE_TO_CONVERGENCE_REMINDER = [
  "PR created successfully. Drive it to convergence per the §User-does-not-review-PRs",
  "rule in `decision-defaults.mdc` — the user is NOT the next actor.",
  "",
  "**Required next action (do not end the turn here):**",
  "- Call `mcp__minsky__session_pr_wait-for-review` with `reviewer: 'minsky-reviewer[bot]'`",
  "  to block until the reviewer bot posts (typical 30s–2min after push).",
  "- On silence or zero CI runs: read the PR's OWN merge state FIRST —",
  "  `mergeable === false` means conflicts, so GitHub never built the merge ref",
  "  and dispatched no `pull_request` workflow. Fix: `session_update` + resolve.",
  "  An empty-commit nudge does nothing there and invalidates the approval.",
  "- Only once merge state is clean: push an empty commit to wake the webhook",
  "  (`session_commit` with `noFiles: true, noStage: true`), then re-wait.",
  "  If still silent after the second wait, proceed to bypass merge.",
  "- On APPROVE: call `mcp__minsky__session_pr_merge`.",
  "- On CHANGES_REQUESTED: apply fixes per §7 Convergence Checklist (class-",
  "  not-instance + cascade-defense), push, re-wait.",
  "",
  "**Do NOT dispatch a reviewer subagent or invoke /review-pr.**",
  "The reviewer bot (`minsky-reviewer[bot]`) is the only review surface.",
  "See memory `5695cd2b` for the full rationale.",
  "",
  "**Forbidden — these phrases end the turn prematurely:**",
  '- "Ping me when done"',
  '- "Let me know when merged"',
  '- "I\'ll wait for your signal"',
  '- "Ready for your review/merge"',
  "- Any equivalent deferral that ends the turn before merge.",
  "",
  "The slow-ask variant (deferring to a later user ping) is forbidden under",
  "the same rule as the immediate-ask variant. Drive to merge first; surface",
  "only at merge or on a genuinely-blocking failure (CI failure, structural",
  "convergence failure documented in feedback_bot_authored_pr_convergence).",
].join("\n");

/**
 * The verdict: the reminder text, or `null` when the hook should stay silent.
 *
 * Silent on a non-matching tool, and silent on a failed creation — the agent
 * already gets the failure surface from the call itself, and there is no PR to
 * drive.
 */
export function decidePrConvergenceReminder(input: PrConvergenceReminderInput): string | null {
  if (input.toolName !== PR_CREATE_TOOL_NAME) {
    return null;
  }
  if (!input.succeeded) {
    return null;
  }
  return DRIVE_TO_CONVERGENCE_REMINDER;
}
