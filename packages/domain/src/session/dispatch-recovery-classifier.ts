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
 * mt#3086 update: `computeDispatchStaleness` below now ALSO consults a
 * presence-claim-derived tool-call-activity signal, not just commit
 * timestamps — see that function's docstring for the full rationale (why
 * the harness transcript JSONL mtime was evaluated and rejected in favor of
 * the `presence_claims` table) and the documented residual blind spot.
 *
 * mt#3149 update: `classifyDispatchRecoveryState` below now ALSO consults
 * PR existence as a liveness signal, not just `commitsAheadOfBase` — see
 * that function's docstring for the originating incident (a dispatch with
 * an open PR and pushed commits was classified `crashed-no-output` twice,
 * because the CALLER never re-probed live state at all for the second
 * classification — see `dispatch-recover-command.ts`'s escalate-branch
 * restructuring for the other half of this fix).
 *
 * @see mt#2831 — this task (original staleness/classification/prompt logic)
 * @see mt#3086 — false-positive staleness fix (presence-claim liveness signal)
 * @see mt#3149 — false-positive crashed-no-output fix (PR-existence liveness signal)
 * @see mt#2646 — dispatch-watchdog detection + the recovery-probe shape reused here
 * @see packages/domain/src/session/dispatch-recovery-probe.ts — the probe shape
 * @see packages/domain/src/storage/schemas/subagent-invocations-schema.ts — the outcome enum
 * @see docs/architecture/presence-claims.md — the presence-claim subsystem this borrows
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

/**
 * Which signal produced `lastActivityAtMs` (mt#3086). Surfaced so a caller
 * can explain WHY a dispatch was judged healthy — in particular so
 * "healthy, no commits, but recent tool-call activity" is distinguishable
 * from "healthy, recent commit" in logs/messages, rather than collapsing
 * both into an opaque timestamp.
 */
export type DispatchActivitySource = "dispatch-start" | "commit" | "presence";

/** Result of the staleness check for a single in-flight invocation. */
export interface DispatchStalenessResult {
  /** True when the dispatch has gone silent for at least `staleMs`. */
  stale: boolean;
  /** Ms epoch of the most recent activity signal found (dispatch start, last commit, or presence-claim activity). */
  lastActivityAtMs: number;
  /** `nowMs - lastActivityAtMs`. */
  staleForMs: number;
  /** Which signal produced `lastActivityAtMs`. */
  activitySource: DispatchActivitySource;
}

/**
 * Determine whether an in-flight dispatch has gone silent long enough to be
 * treated as died/stalled.
 *
 * ## Signals consulted (mt#3086)
 *
 * "Activity" is the MAX of three signals: the dispatch's `startedAtMs`, the
 * last commit timestamp on its session branch (`lastCommitAtMs`), and — new
 * in mt#3086 — the most recent `presence_claims` refresh for the dispatch's
 * Minsky session (`lastPresenceActivityAtMs`). Before mt#3086 this function
 * only consulted the first two, which meant a dispatch that was genuinely
 * alive and working (reading code, running tests, making session-scoped MCP
 * tool calls) but had not yet committed anything was indistinguishable from
 * a dead one — the mt#3086 originating incident (a same-session
 * double-dispatch race triggered by exactly this false positive).
 *
 * ## Why `presence_claims`, not the harness transcript JSONL mtime
 *
 * The mt#3086 spec named the harness's transcript JSONL mtime as the
 * "cheap proxy" candidate for tool-call-level activity. It was evaluated and
 * rejected for THIS signal slot: the JSONL file is keyed by the harness's
 * OWN agent-session id, and `subagent_invocations.agent_session_id` is only
 * populated by the SubagentStop hook (`.minsky/hooks/record-subagent-invocation.ts`)
 * — i.e. only AFTER the dispatch is no longer in-flight, which is precisely
 * the state this function is trying to distinguish from "alive but quiet."
 * For an in-flight row the join key genuinely does not exist yet, so the
 * JSONL path is unreachable here regardless of whether the server can reach
 * the harness's local filesystem (a separate, ALSO-true portability concern
 * for a future hosted-MCP deployment).
 *
 * `presence_claims` (subject_kind = "session", `docs/architecture/presence-claims.md`,
 * mt#2284) is the best DB-side substitute: `src/mcp/server.ts`'s
 * `writeSessionAttachment` refreshes a session-grain claim's
 * `last_refreshed_at` on EVERY MCP tool call that resolves to a Minsky
 * session (`session_exec`, `session_read_file`, `session_grep_search`,
 * `validate_typecheck`, etc.) — which covers the exact "long local
 * diagnosis loop, no commits" scenario from the originating incident, since
 * that loop is made almost entirely of such calls. It is DB-side (no local
 * filesystem read, portable to a hosted MCP server) and keyed on the Minsky
 * SESSION id, which this command already has (`subagentSessionId`) — no new
 * join key is needed.
 *
 * ## Residual blind spot (documented, not silently accepted)
 *
 * A dispatch that goes an entire `staleMs` window WITHOUT making any
 * Minsky-MCP-routed tool call — e.g. stuck inside one very long non-MCP
 * subprocess call — is still invisible to every signal here (commit,
 * presence, or otherwise) and will still misclassify as `recover`. This is
 * a real, narrower gap than the pre-mt#3086 state (which missed a much
 * broader class: any quiet-but-MCP-active stretch), not a claim of full
 * coverage.
 *
 * **SendMessage-resumed agent confound.** A `SendMessage`-resumed subagent
 * (per `subagent-routing.mdc`'s "Continuation" section) writes no NEW
 * `subagent_invocations` row — but because `presence_claims` is keyed on the
 * Minsky SESSION id, not on the invocation row, a SendMessage-resumed
 * agent's own tool calls keep refreshing the SAME session-grain claim this
 * function reads. So as long as the invocation row this function is
 * evaluating is still open (`endedAt IS NULL` — e.g. it was itself produced
 * by a PRIOR `tasks.dispatch-recover` auto-resume, per that command's
 * `recordDispatchRecoveryAttempt`), a SendMessage-resumed continuation's
 * activity IS visible here. The one case where it is NOT visible: if the
 * row had already been closed (`endedAt` set, e.g. by the original
 * SubagentStop) before the SendMessage resume happened — the calling
 * command (`dispatch-recover-command.ts`) returns `not-in-flight` before
 * ever reaching this function, so a SendMessage-resumed continuation of an
 * already-Stopped dispatch is never staleness-checked at all (arguably
 * correct: from `subagent_invocations`' point of view nothing is "in
 * flight" to recover).
 *
 * Pure and synchronous — no I/O. Unit-testable with an injected clock.
 */
export function computeDispatchStaleness(
  startedAtMs: number,
  lastCommitAtMs: number | null,
  nowMs: number,
  staleMs: number = DISPATCH_RECOVERY_STALE_MS,
  lastPresenceActivityAtMs: number | null = null
): DispatchStalenessResult {
  let lastActivityAtMs = startedAtMs;
  let activitySource: DispatchActivitySource = "dispatch-start";

  if (lastCommitAtMs !== null && lastCommitAtMs > lastActivityAtMs) {
    lastActivityAtMs = lastCommitAtMs;
    activitySource = "commit";
  }
  if (lastPresenceActivityAtMs !== null && lastPresenceActivityAtMs > lastActivityAtMs) {
    lastActivityAtMs = lastPresenceActivityAtMs;
    activitySource = "presence";
  }

  const staleForMs = nowMs - lastActivityAtMs;
  return { stale: staleForMs >= staleMs, lastActivityAtMs, staleForMs, activitySource };
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
  /**
   * Whether a still-open (or draft) PR exists for the session branch
   * (mt#3149). This is DIRECT, POSITIVE evidence of prior output — a PR
   * cannot exist without a push having happened — and is deliberately
   * consulted INDEPENDENTLY of `commitsAheadOfBase`, which is a `git
   * rev-list`-derived proxy that can misreport zero for reasons unrelated to
   * whether the dispatch actually produced anything (e.g. the caller not
   * re-probing live state before reporting a classification — see the
   * mt#3149 originating incident: a dispatch with PR #2244 open and commits
   * pushed was classified `crashed-no-output` because the CALLER never
   * re-ran the commits-ahead probe for that classification at all, not
   * because the probe itself misread a ref/worktree). A caller that cannot
   * determine PR state should pass `false` — this is the conservative
   * default that preserves the pre-mt#3149 behavior for the case where no
   * PR information is available.
   */
  hasOpenPr: boolean;
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
 *   3. Clean tree, commits ahead of base OR an open PR exists -> `committed-no-pr`
 *      (work landed cleanly; the dispatch died before `session_pr_create`,
 *      or — when a PR already exists — before driving it to convergence;
 *      the continuation-prompt builder differentiates those two shapes via
 *      the caller-supplied `prExists`/`prNumber`, since both map to this
 *      same persisted outcome value). mt#3149: an open PR is checked HERE,
 *      as an alternative to `commitsAheadOfBase > 0` rather than a
 *      replacement for it — either signal alone is sufficient, since a PR
 *      implies commits were pushed even when `commitsAheadOfBase`'s
 *      `git rev-list` comparison happens to read stale or zero.
 *   4. Clean tree, no commits, no PR     -> `crashed-no-output`
 *      (nothing was ever produced — the dispatch died at or before its
 *      first commit). This is the ONLY path to `crashed-no-output` — a
 *      dispatch with an open PR or commits ahead of base can never reach it
 *      (mt#3149 SC1/SC2), and this is the class the hard constraint (mt#3149
 *      Acceptance Test 4) pins: a genuinely dead dispatch (no PR, no
 *      commits, no dirty tree) must still land here — this branch is not
 *      weakened by the mt#3149 fix, only the OTHER branches gained a new
 *      way to be reached.
 *
 * Pure — no I/O.
 */
export function classifyDispatchRecoveryState(
  input: DispatchRecoveryClassificationInput
): DispatchRecoveryClassification {
  const hasCommits = (input.commitsAheadOfBase ?? 0) > 0;
  // mt#3149: an open PR is positive, direct evidence of prior output,
  // independent of (and not overridden by) a possibly-stale/zero
  // `commitsAheadOfBase` reading. See this function's docstring, step 3.
  const hasPositiveLivenessEvidence = hasCommits || input.hasOpenPr;

  if (input.dirtyFileCount > 0) {
    return input.handoffExists
      ? "partial-committed-handoff-written"
      : "partial-uncommitted-no-handoff";
  }

  if (hasPositiveLivenessEvidence) {
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
