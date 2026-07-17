/**
 * Dispatch-recovery classifier (mt#2831) — pure functions for the
 * `tasks.dispatch-recover` command: staleness detection, outcome
 * classification, and continuation-prompt assembly.
 *
 * No I/O in this module. The adapter-layer command
 * (`src/adapters/shared/commands/tasks/dispatch-recover-command.ts`) gathers
 * raw state (git status, commits-ahead, handoff.md, PR/review info — reusing
 * the `dispatch-recovery-probe.ts` shape from mt#2646) and passes it through
 * these functions so the recovery LOGIC is unit-testable without spawning a
 * subprocess or hitting a database.
 *
 * Plan decision (mt#2831 spec, 2026-07-17): server-side code cannot spawn
 * harness subagents, so the protocol splits into (1) server-side
 * detect/classify/prepare (this module + the command that calls it) and
 * (2) agent-side execution (the orchestrating agent calls the recover
 * command and redispatches the returned prompt verbatim). This module is
 * entirely (1) — it never dispatches anything.
 *
 * @see mt#2831 — this task
 * @see mt#2646 — dispatch-watchdog detection + the recovery-probe shape reused here
 * @see packages/domain/src/session/dispatch-recovery-probe.ts — the probe shape
 * @see packages/domain/src/storage/schemas/subagent-invocations-schema.ts — the outcome enum
 */

import type { SubagentInvocationOutcome } from "../storage/schemas/subagent-invocations-schema";

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Default "no activity" window before an in-flight dispatch is considered
 * died/stalled. Mirrors `DISPATCH_WATCHDOG_STALE_MS`
 * (`src/cockpit/dispatch-watchdog.ts`) in both value and rationale — the
 * recover command consumes the SAME threshold concept the watchdog producer
 * uses (per the spec's "v1 consumes the EXISTING watchdog signal" sequencing
 * note) rather than inventing an unrelated bar. Duplicated as a constant
 * here (not imported from `src/cockpit/*`) to keep this module dependency-free
 * of the cockpit sweep's DB/git wiring — see the command file for the
 * cross-reference comment tying the two together.
 */
export const DISPATCH_RECOVERY_STALE_MS = 30 * 60 * 1000;

/** Result of the staleness check for a single in-flight invocation. */
export interface DispatchStalenessResult {
  /** True when the dispatch has gone silent for at least `staleMs`. */
  stale: boolean;
  /** Ms epoch of the most recent activity signal found (dispatch start or last commit). */
  lastActivityAtMs: number;
  /** `nowMs - lastActivityAtMs`. */
  staleForMs: number;
}

/**
 * Determine whether an in-flight dispatch has gone silent long enough to be
 * treated as died/stalled.
 *
 * "Activity" is the MAX of the dispatch's `startedAtMs` and the last commit
 * timestamp on its session branch (`lastCommitAtMs`), mirroring
 * `computeDispatchWatchdogFlags`'s activity model minus the `system_events`
 * signal — the recover command is a synchronous, on-demand check against a
 * single dispatch (no DB aggregation), so it intentionally omits the
 * broader event-stream signal the periodic watchdog sweep uses. This is a
 * documented simplification (see the command file's Does-NOT-cover note),
 * not a silent gap: a dispatch whose only recent activity was a PR/review
 * event (no commit) will be treated as stale slightly earlier here than the
 * full watchdog sweep would flag it — acceptable since recovering "early"
 * on such a dispatch degrades to the false-positive-kill acceptance test
 * case (probe shows a healthy, near-complete state; the continuation prompt
 * just tells the resumed agent to check PR/review status first).
 *
 * Pure and synchronous — no I/O. Unit-testable with an injected clock.
 */
export function computeDispatchStaleness(
  startedAtMs: number,
  lastCommitAtMs: number | null,
  nowMs: number,
  staleMs: number = DISPATCH_RECOVERY_STALE_MS
): DispatchStalenessResult {
  const lastActivityAtMs =
    lastCommitAtMs !== null ? Math.max(startedAtMs, lastCommitAtMs) : startedAtMs;
  const staleForMs = nowMs - lastActivityAtMs;
  return { stale: staleForMs >= staleMs, lastActivityAtMs, staleForMs };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The outcome-taxonomy subset applicable to a died/stalled dispatch (per the
 * mt#2831 spec's classify step: "committed-no-pr / partial-uncommitted /
 * crashed-no-output"). Deliberately excludes `completed-with-pr` (that's a
 * healthy outcome, not a recovery case) and `rate-limited` (out of this
 * task's scope per its Covers/Does-NOT-cover — the tracker's own escalation
 * handles rate-limit storms). Values are exactly 4 of the 6 persisted
 * `SubagentInvocationOutcome` enum values, so a classification here writes
 * directly to the `outcome` column with no further mapping.
 */
export const DISPATCH_RECOVERY_CLASSIFICATION_VALUES = [
  "committed-no-pr",
  "partial-committed-handoff-written",
  "partial-uncommitted-no-handoff",
  "crashed-no-output",
] as const satisfies readonly SubagentInvocationOutcome[];

export type DispatchRecoveryClassification =
  (typeof DISPATCH_RECOVERY_CLASSIFICATION_VALUES)[number];

/** Raw workspace-state inputs the classifier decides from. */
export interface DispatchRecoveryClassificationInput {
  /** Total staged + unstaged + untracked file count. */
  dirtyFileCount: number;
  /** Commits on the session branch not yet on the base branch, or null if undeterminable. */
  commitsAheadOfBase: number | null;
  /** Whether `.minsky/sessions/<id>/handoff.md` exists. */
  handoffExists: boolean;
}

/**
 * Classify a died/stalled dispatch's workspace state into one of the 4
 * recovery-relevant outcome classes.
 *
 * Decision order (dirty tree is checked first — uncommitted work is the
 * highest-priority signal regardless of what else is true):
 *   1. Dirty tree + handoff.md present  -> `partial-committed-handoff-written`
 *      (the graceful-partial class: SOME work was committed and a handoff
 *      note was written, but the exit wasn't fully clean — memory `27707491`
 *      documents this exact "handoff written but stray uncommitted edit
 *      remained" shape).
 *   2. Dirty tree, no handoff.md        -> `partial-uncommitted-no-handoff`
 *      (the failure class per `subagent-dispatch-cadence.mdc` — lost/stranded
 *      work a successor can't find automatically without this probe).
 *   3. Clean tree, commits ahead of base -> `committed-no-pr`
 *      (work landed cleanly; the dispatch died before `session_pr_create`,
 *      or — when a PR already exists — before driving it to convergence;
 *      the continuation-prompt builder differentiates those two shapes via
 *      the caller-supplied `prExists`/`prNumber`, since both map to this
 *      same persisted outcome value).
 *   4. Clean tree, no commits            -> `crashed-no-output`
 *      (nothing was ever produced — the dispatch died at or before its
 *      first commit).
 *
 * Pure — no I/O.
 */
export function classifyDispatchRecoveryState(
  input: DispatchRecoveryClassificationInput
): DispatchRecoveryClassification {
  const hasCommits = (input.commitsAheadOfBase ?? 0) > 0;

  if (input.dirtyFileCount > 0) {
    return input.handoffExists
      ? "partial-committed-handoff-written"
      : "partial-uncommitted-no-handoff";
  }

  if (hasCommits) {
    return "committed-no-pr";
  }

  return "crashed-no-output";
}

// ---------------------------------------------------------------------------
// Continuation prompt
// ---------------------------------------------------------------------------

/** Inputs the continuation-prompt builder needs beyond the raw classification. */
export interface DispatchRecoveryPromptInput {
  taskId: string;
  sessionId: string;
  sessionDir: string;
  agentType: string;
  classification: DispatchRecoveryClassification;
  dirtyFileCount: number;
  commitsAheadOfBase: number | null;
  handoffExists: boolean;
  handoffFirstLines: string[];
  prNumber: number | null;
  prUrl: string | null;
  latestReviewState: string | null;
  attemptNumber: number;
  originalStartedAt: string;
}

/**
 * Build a ready-to-dispatch, session-bound continuation prompt describing
 * the recovered state and what the resumed agent should do next.
 *
 * The prompt is deliberately self-contained (per the no-mid-flight-correction
 * doctrine, mt#2512 — a fresh dispatch has no memory of a prior turn, so
 * every fact it needs must be IN the prompt, not implied by context) and
 * classification-specific: each of the 4 outcome classes gets different
 * guidance about what to do first.
 *
 * Pure — no I/O, no template engine, just string assembly. Unit-testable by
 * asserting on substrings (exact wording is expected to evolve).
 */
export function buildDispatchRecoveryContinuationPrompt(
  input: DispatchRecoveryPromptInput
): string {
  const lines: string[] = [];

  lines.push(
    `RESUMED DISPATCH (attempt ${input.attemptNumber} of 2) — mt#2831 auto-recovery`,
    "",
    `This is a continuation of a subagent dispatch for task ${input.taskId} that went silent ` +
      `(no activity for the watchdog stale window) and was auto-recovered. You are resuming ` +
      `work in the SAME Minsky session — do NOT start a new session, do NOT re-implement from ` +
      `scratch unless the state summary below says there is nothing to build on.`,
    "",
    `Session: ${input.sessionId}`,
    `Session directory: ${input.sessionDir}`,
    `Original dispatch started at: ${input.originalStartedAt}`,
    "",
    "## Recovered state summary",
    "",
    `- Classification: ${input.classification}`,
    `- Uncommitted files: ${input.dirtyFileCount}`,
    `- Commits ahead of base: ${input.commitsAheadOfBase ?? "unknown"}`,
    `- handoff.md present: ${input.handoffExists ? "yes" : "no"}`,
    `- PR: ${input.prNumber ? `#${input.prNumber} (${input.prUrl ?? "url unknown"})` : "none yet"}`,
    `- Latest review state: ${input.latestReviewState ?? "n/a"}`
  );

  if (input.handoffExists && input.handoffFirstLines.length > 0) {
    lines.push("", "## handoff.md (first lines)", "", "```", ...input.handoffFirstLines, "```");
  }

  lines.push("", "## What to do next");

  switch (input.classification) {
    case "partial-uncommitted-no-handoff":
      lines.push(
        `You have ${input.dirtyFileCount} uncommitted file(s) from the prior attempt and no ` +
          "handoff note explaining them. First: run a diff/status read on the session workspace " +
          "to understand what's there. If the changes are sound, commit them (with a `partial:` " +
          "message if still incomplete) before doing anything else — do NOT discard them. If they " +
          "look wrong or half-finished in a way you can't safely continue, it is fine to stash or " +
          "revert them and restart the affected piece, but say so explicitly rather than silently " +
          "dropping the diff."
      );
      break;
    case "partial-committed-handoff-written":
      lines.push(
        "The prior attempt committed some work and left a handoff note (reproduced above). Read " +
          "it, verify the stated 'Done' items against the actual diff, then continue from " +
          "'Remaining'. If uncommitted files remain (see the summary above), commit or resolve " +
          "them before starting new work."
      );
      break;
    case "committed-no-pr":
      lines.push(
        input.prNumber
          ? `A PR already exists (#${input.prNumber}). The dispatch likely died mid-convergence ` +
              "(waiting on reviewer-bot, or mid-fix-round). Check the PR's current review state and " +
              "drive it to convergence per /implement-task §9 — do not re-implement work that's " +
              "already committed and under review."
          : "The prior attempt's work is committed cleanly but no PR was created yet. Verify the " +
              "committed diff satisfies the task spec's acceptance criteria, then create the PR " +
              "per /implement-task §8. Do not re-implement work that's already committed."
      );
      break;
    case "crashed-no-output":
      lines.push(
        "The prior attempt produced no commits and no uncommitted changes — it died before making " +
          "any progress (or before that progress reached disk). Treat this as a fresh start: read " +
          "the task spec and begin implementation. There is nothing to recover from the workspace " +
          "itself, but the session/branch already exist — keep working in them."
      );
      break;
  }

  lines.push(
    "",
    "Follow the operating envelope from your original dispatch prompt (checkpoint cadence, " +
      "handoff.md convention) for this attempt as well — this is attempt " +
      `${input.attemptNumber} of 2; there will be no third auto-resume for this dispatch.`
  );

  return lines.join("\n");
}
