/**
 * Dispatch-recovery probe (mt#2646) — the shape-assembly layer for
 * `session.status`'s `probe: true` mode.
 *
 * When an orchestrator needs to decide how to recover a subagent dispatch
 * that the watchdog (`src/cockpit/dispatch-watchdog.ts`) has flagged as
 * silent, it needs several pieces of state in ONE read: PR number + latest
 * review state, branch commits ahead of base, dirty-file count, and
 * handoff.md presence/content. Before this, recovering that state required
 * several separate tool calls (session.status for git status, session.pr.get
 * for PR info, a manual file read for handoff.md, a manual git rev-list for
 * commits-ahead).
 *
 * This module is the PURE shape-assembly function
 * (`buildDispatchRecoveryProbe`) plus a small output parser
 * (`parseCommitsAheadOutput`) — no I/O, no git subprocess, no network. The
 * MCP handler in `src/adapters/mcp/session-workspace.ts` gathers the raw
 * pieces (git status, `git rev-list --count`, a handoff.md read, the session
 * record's cached PR info, and a best-effort live review-state fetch) and
 * passes them through this function so the resulting shape is unit-testable
 * without spawning processes or hitting the network.
 *
 * @see mt#2646 — this task
 * @see src/adapters/mcp/session-workspace.ts — the `session.status` handler that calls this
 * @see src/cockpit/dispatch-watchdog.ts — the detection layer that flags a dispatch worth probing
 */

export interface DispatchRecoveryProbeGitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** Latest review on the session's PR, if any review has been posted. */
export interface DispatchRecoveryProbeLatestReview {
  state: string; // e.g. "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  reviewerLogin: string | null;
  submittedAt: string | null;
}

/** PR + review-state slice of the probe. */
export interface DispatchRecoveryProbePr {
  number: number | null;
  url: string | null;
  /** PR state as last recorded on the session record (open/closed/merged/draft), or null if no PR yet. */
  state: string | null;
  /** The most recently posted review, or null if none / not fetched. */
  latestReview: DispatchRecoveryProbeLatestReview | null;
  /**
   * Set when a live review-state fetch was attempted and failed (network,
   * auth, no backend support). The probe still returns everything else —
   * a review-fetch failure must not blank the rest of the recovery state.
   */
  reviewFetchError: string | null;
}

/** handoff.md presence/content slice of the probe. */
export interface DispatchRecoveryProbeHandoff {
  exists: boolean;
  firstLines: string[];
}

/** The full one-call recovery-state shape returned by `session.status` with `probe: true`. */
export interface DispatchRecoveryProbeResult {
  session: string;
  dirtyFileCount: number;
  gitStatus: DispatchRecoveryProbeGitStatus;
  /** Commits on the session branch ahead of `baseBranch`, or null if undeterminable (no base, git error). */
  commitsAheadOfBase: number | null;
  baseBranch: string | null;
  pr: DispatchRecoveryProbePr;
  handoff: DispatchRecoveryProbeHandoff;
}

/** Default cap on how many lines of handoff.md content to surface (avoid dumping a huge file into a probe response). */
export const DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES = 20;

/**
 * Assemble the one-call recovery-state shape from raw, already-fetched
 * inputs. Pure — no I/O. `handoffFileContent` is `null` when the file does
 * not exist (as opposed to an empty string, which means the file exists but
 * is empty).
 */
export function buildDispatchRecoveryProbe(input: {
  session: string;
  gitStatus: DispatchRecoveryProbeGitStatus;
  commitsAheadOfBase: number | null;
  baseBranch: string | null;
  pr: DispatchRecoveryProbePr;
  handoffFileContent: string | null;
  handoffMaxLines?: number;
}): DispatchRecoveryProbeResult {
  const dirtyFileCount =
    input.gitStatus.staged.length +
    input.gitStatus.unstaged.length +
    input.gitStatus.untracked.length;

  const maxLines = input.handoffMaxLines ?? DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES;
  const handoff: DispatchRecoveryProbeHandoff =
    input.handoffFileContent === null
      ? { exists: false, firstLines: [] }
      : { exists: true, firstLines: input.handoffFileContent.split("\n").slice(0, maxLines) };

  return {
    session: input.session,
    dirtyFileCount,
    gitStatus: input.gitStatus,
    commitsAheadOfBase: input.commitsAheadOfBase,
    baseBranch: input.baseBranch,
    pr: input.pr,
    handoff,
  };
}

/**
 * Parse the output of `git rev-list --count <base>..HEAD` into a number.
 * Returns null on unparseable/empty output rather than throwing — the probe
 * must degrade gracefully (missing base ref, detached HEAD, etc.) instead of
 * failing the whole one-call read.
 */
export function parseCommitsAheadOutput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}
