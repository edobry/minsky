/**
 * Session PR Checks Subcommand
 *
 * Reports CI check-run status for the pull request associated with a session.
 * Supports an optional wait/polling mode that blocks until all checks complete
 * (or the timeout is reached).
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "@minsky/shared/logger";
import type { CheckRunResult, ChecksResult, RepositoryBackend } from "../../repository/index";
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import { withDeadline, DeadlineExceededError } from "../../utils/deadline";

// ── Trimmed checks payload (mt#2656) ────────────────────────────────────

/**
 * Trimmed checks payload used by `session.pr.drive`'s convergence-tail mode
 * (mt#2656). When every check passed, the per-check breakdown is dropped —
 * the summary counts are all a caller needs to confirm green. When at least
 * one check is not passing (failed or still pending), `failingChecks`
 * carries just those entries (name/status/conclusion/url) so the caller can
 * see what to fix or wait on, without the full list of already-passing
 * check names.
 */
export interface TrimmedChecksResult {
  allPassed: boolean;
  timedOut?: boolean;
  summary: ChecksResult["summary"];
  /** Present (possibly empty) only when `allPassed` is false. */
  failingChecks?: CheckRunResult[];
  /**
   * Carried through from {@link ChecksResult} (mt#4182 / PR #3042 R1). The trim
   * drops the per-check breakdown, not the REASON: without this, the drive
   * path sees `allPassed: false` with an empty `failingChecks` and zero counts,
   * which reads as "nothing is wrong and nothing ran" for a conflicted PR.
   */
  mergeBlocked?: string;
}

/** A check counts as "not passing" for the failingChecks filter below. */
function isFailingOrPending(check: CheckRunResult): boolean {
  if (check.status !== "completed") return true;
  return (
    check.conclusion !== "success" &&
    check.conclusion !== "neutral" &&
    check.conclusion !== "skipped"
  );
}

/**
 * Trim a full `ChecksResult` down to the mt#2656 default payload.
 *
 * Three callers as of mt#4657: `session.pr.drive`'s composition, the
 * `session.pr.checks` adapter's structured branch, and unit tests. mt#2656
 * shipped this for drive only and deliberately left `session.pr.checks` at
 * full detail; mt#4657 reversed that on measured caller behaviour (see the
 * comment at the `session.pr.checks` callsite). Both callers gate it on the
 * same `fullBody` param, so the trimmed shape is one contract, not two.
 */
export function trimChecksResult(result: ChecksResult): TrimmedChecksResult {
  if (result.allPassed) {
    return { allPassed: true, summary: result.summary };
  }
  return {
    allPassed: false,
    ...(result.timedOut ? { timedOut: true as const } : {}),
    ...(result.mergeBlocked ? { mergeBlocked: result.mergeBlocked } : {}),
    summary: result.summary,
    failingChecks: result.checks.filter(isFailingOrPending),
  };
}

/**
 * Fold the PR's merge state into a checks result (mt#4182).
 *
 * `getChecksForPR` honestly reports the checks it found, and `allPassed`
 * already refuses to be true on an EMPTY set (`allChecks.length > 0` in
 * `github-pr-checks.ts`). What that floor cannot see is a set of one: a PR with
 * merge conflicts gets no `refs/pull/N/merge`, so GitHub dispatches no
 * `pull_request` workflow, and the single check that remains is the one that
 * never needed the merge ref — the reviewer bot's own findings run. It passes,
 * the floor clears, and the caller reads green for a PR whose CI never started.
 * Observed on PR #3031 (2026-08-16): `allPassed: true`, `total: 1`, zero
 * workflow runs; resolving the conflict dispatched all 8 immediately.
 *
 * **Why merge state and not a check-count threshold.** "Require more than one
 * check" is a guess about a repo's CI shape — a repo may legitimately run one —
 * and it carries no information about WHY the set is small. The PR's own merge
 * state names the cause.
 *
 * **Why `mergeable === false` specifically**, and not the broader
 * `hasNonApprovalMergeBlockers` that `computeNonApprovalMergeBlockers` returns:
 * that predicate also fires on draft and not-open PRs, and a draft PR runs its
 * workflows normally. Only a conflict prevents the merge ref from existing.
 * `mergeable === null` — GitHub still computing, which a GET itself triggers —
 * is deliberately NOT treated as blocked, the same call mt#2890 made for the
 * approval path; a single read is not authoritative and failing closed on it
 * would report an unknown as a conflict.
 *
 * Pure, and takes the merge state as a PARAMETER rather than fetching it, so
 * the CI capability keeps reporting only what it observed. ADR-005 groups PR
 * state under `backend.pr`, not `backend.ci`; composing here respects that
 * boundary instead of reaching across it inside the fetch.
 */
export function applyMergeStateToChecks(
  result: ChecksResult,
  mergeable: boolean | null | undefined
): ChecksResult {
  if (mergeable !== false) return result;
  return {
    ...result,
    allPassed: false,
    mergeBlocked:
      "PR has merge conflicts, so GitHub could not build the merge ref and " +
      "dispatched no pull_request workflows — the checks below are not evidence " +
      "CI ran. Resolve the conflict (session update), then re-check.",
  };
}

export interface SessionPrChecksDependencies {
  sessionDB: SessionProviderInterface;
  /**
   * Test seam: override backend creation. Defaults to the session-derived
   * backend. Mirrors `SessionPrWaitForReviewDependencies.createBackend` so
   * composing callers (e.g. `session.pr.drive`, mt#2647) can inject a fake
   * backend for both the review-wait and checks-wait steps.
   */
  createBackend?: (
    sessionRecord: Parameters<typeof createRepositoryBackendFromSession>[0],
    sessionDB: SessionProviderInterface
  ) => Promise<RepositoryBackend>;
  /** Test seam: override the clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: override the delay between polls. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * mt#2677: optional progress callback, invoked once per poll iteration in
   * wait mode (right before sleeping, when checks are still pending). See
   * `SessionPrWaitForReviewDependencies.onProgress` for the full rationale —
   * this is the checks-wait sibling of the same mechanism.
   *
   * mt#4020: in wait mode, ALSO invoked exactly once at the very start of
   * the call, before session resolution and backend construction run — the
   * only progress signal reachable during that setup phase, which previously
   * had none at all (the incident this closes: a hang there produced no
   * progress and no response, indistinguishable from a wedged connection).
   */
  onProgress?: (message: string) => void;
}

export interface SessionPrChecksParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  /** When true, poll until all checks complete (or timeout). */
  wait?: boolean;
  /** Maximum seconds to wait when wait=true (default: 600). */
  timeoutSeconds?: number;
  /** Polling interval in seconds when wait=true (default: 30). */
  intervalSeconds?: number;
}

/**
 * Get (and optionally wait for) CI check status for a session pull request.
 */
export async function sessionPrChecks(
  params: SessionPrChecksParams,
  deps: SessionPrChecksDependencies
): Promise<ChecksResult> {
  const { sessionDB } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const createBackend = deps.createBackend ?? createRepositoryBackendFromSession;
  const timeoutMs = (params.timeoutSeconds ?? 600) * 1000;
  const intervalMs = (params.intervalSeconds ?? 30) * 1000;

  // mt#4020: in wait mode, compute the deadline for the WHOLE call — before
  // any setup work runs — so `timeoutSeconds` bounds session resolution and
  // backend construction too, not just the poll loop below. mt#2677 bounded
  // every fetchChecks() call inside the loop to a deadline computed AFTER
  // setup completed; that left setup itself (resolveSessionContextWithFeedback
  // and sessionDB.getSession — both unbounded DB round-trips; createBackend's
  // GitHubBackend construction is synchronous and was ruled out by reading
  // it) able to hang with no bound and no onProgress reachable at all. The
  // observed incident (PR #2891) sat silent for 1824s against a 900s
  // timeoutSeconds — well past twice the deadline the loop alone could ever
  // produce — which is the signature of an unbounded stall upstream of the
  // loop, not a loop that overran its own bound.
  const deadline = params.wait ? now() + timeoutMs : undefined;

  try {
    /**
     * Setup: resolve the session, load its PR number, and construct the
     * repository backend. In wait mode this is wrapped below with
     * `withDeadline` against the SAME deadline the poll loop uses (mt#4020)
     * — a stall here is bounded exactly like a stall inside the loop's
     * fetchChecks() calls, not a separate unbounded budget.
     */
    async function runSetup(): Promise<{ prNumber: number; backend: RepositoryBackend }> {
      const resolvedContext = await resolveSessionContextWithFeedback({
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        sessionProvider: sessionDB,
        allowAutoDetection: true,
      });

      const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
      if (!sessionRecord) {
        throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
      }

      // Require an existing PR
      const prNumber = sessionRecord.pullRequest?.number;
      if (!prNumber) {
        throw new ResourceNotFoundError(
          `No pull request found for session '${resolvedContext.sessionId}'. ` +
            `Use 'minsky session pr create' to create a PR first.`
        );
      }

      // Create repository backend from session record
      const backend = await createBackend(sessionRecord, deps.sessionDB);
      return { prNumber: prNumber as number, backend };
    }

    let setup: { prNumber: number; backend: RepositoryBackend };
    if (deadline !== undefined) {
      // mt#4020 / AT4 corollary: a pre-loop hang used to produce no progress
      // AND no response — exactly the MCP idle-abort signature observed in
      // the incident (deps.onProgress?.() was only ever reached inside the
      // loop). One ping as setup begins gives a caller a signal the call is
      // alive before the poll loop's own per-interval pings can start, so a
      // genuinely slow (but working) setup is distinguishable from silence.
      deps.onProgress?.("Resolving session and repository backend...");
      try {
        setup = await withDeadline(runSetup(), Math.max(0, deadline - now()));
      } catch (ioError) {
        if (!(ioError instanceof DeadlineExceededError)) throw ioError;
        return {
          allPassed: false,
          summary: { total: 0, passed: 0, failed: 0, pending: 0 },
          checks: [],
          timedOut: true,
        };
      }
    } else {
      setup = await runSetup();
    }

    const { prNumber, backend } = setup;

    /**
     * Inner helper: fetch checks via the backend's CI sub-interface.
     */
    async function fetchChecks(): Promise<ChecksResult> {
      log.debug(`Fetching checks for PR #${prNumber}`);
      const checks = await backend.ci.getChecksForPR(prNumber);

      // mt#4182: only a would-be-GREEN result can mislead, so the extra PR read
      // is taken only on that path. A not-passing result already tells the
      // caller to look, and in the wait loop this is also the path that ENDS the
      // poll — so the cost is one GET per call that was about to return
      // "everything passed", not one per poll interval.
      if (!checks.allPassed) return checks;

      // The PR read is a second network call, so it gets its own guard: a
      // checks call that successfully fetched its checks must not fail because
      // the PR endpoint hiccuped, or because a backend does not implement the
      // `pr` capability at all.
      //
      // Bound, stated rather than assumed: on that path the verdict is left
      // ALONE, which is the pre-mt#4182 behavior — so this fix covers the
      // observed conflict case, not a degraded-API one. Failing CLOSED instead
      // would report every GitHub PR-API blip as a conflict, which is a worse
      // trade for a call whose whole job is reporting merge readiness.
      let mergeable: boolean | null | undefined;
      try {
        mergeable = (await backend.pr?.get({ prIdentifier: prNumber }))?.mergeable;
      } catch (prReadError) {
        log.debug(
          "mt#4182: could not read PR merge state; leaving the checks verdict as observed",
          {
            prNumber,
            error: getErrorMessage(prReadError),
          }
        );
        return checks;
      }
      return applyMergeStateToChecks(checks, mergeable);
    }

    // Non-wait mode: single fetch
    if (!params.wait) {
      return fetchChecks();
    }

    // params.wait is true here, so `deadline` was computed above. Narrowed
    // without a non-null assertion — this branch is unreachable in practice.
    if (deadline === undefined) {
      throw new MinskyError("Internal error: deadline not computed for wait mode");
    }

    // mt#2677: bound every fetchChecks() call to the wait's own overall
    // deadline (mirrors the same fix in pr-wait-for-review-subcommand.ts's
    // poll loop) — a stalled backend.ci.getChecksForPR() call with no
    // timeout of its own must not hang the wait past checksTimeoutSeconds.
    //
    // Three DeadlineExceededError catch sites exist in this function, and
    // their return shapes deliberately differ — this is PRE-EXISTING
    // behavior (mt#2677), unchanged by mt#4020's setup-phase addition, not a
    // new divergence:
    //   1. Setup-phase (above, mt#4020) and this FIRST fetchChecks() call
    //      (mt#2677, below) both return IMMEDIATELY with a zeroed
    //      `{timedOut:true}` result on timeout — there is no prior fetch's
    //      data to preserve, so there is nothing to fall through to.
    //   2. Each SUBSEQUENT fetchChecks() call inside the while loop (below)
    //      instead `break`s, falling through to the
    //      `if (!result.allPassed && result.summary.pending > 0)` check
    //      after the loop — `result` still holds the LAST successful poll's
    //      data, so returning `{...result, timedOut:true}` preserves that
    //      partial progress (e.g. which specific checks were still pending)
    //      instead of discarding it for a zeroed result.
    let result: ChecksResult;
    try {
      result = await withDeadline(fetchChecks(), Math.max(0, deadline - now()));
    } catch (ioError) {
      if (!(ioError instanceof DeadlineExceededError)) throw ioError;
      return {
        allPassed: false,
        summary: { total: 0, passed: 0, failed: 0, pending: 0 },
        checks: [],
        timedOut: true,
      };
    }

    while (!result.allPassed && result.summary.pending > 0 && now() < deadline) {
      const remaining = deadline - now();
      const sleepMs = Math.min(intervalMs, remaining);
      if (sleepMs <= 0) break;

      log.info(
        `Waiting for ${result.summary.pending} pending check(s)... ` +
          `(${Math.round(remaining / 1000)}s remaining)`
      );
      // mt#2677: once per poll interval — see SessionPrChecksDependencies.onProgress.
      deps.onProgress?.(
        `Waiting for ${result.summary.pending} pending check(s) ` +
          `(${Math.round(remaining / 1000)}s remaining)`
      );

      await sleep(sleepMs);

      try {
        result = await withDeadline(fetchChecks(), Math.max(0, deadline - now()));
      } catch (ioError) {
        if (!(ioError instanceof DeadlineExceededError)) throw ioError;
        break;
      }
    }

    if (!result.allPassed && result.summary.pending > 0) {
      return { ...result, timedOut: true };
    }

    return result;
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR checks: ${getErrorMessage(error)}`);
  }
}
