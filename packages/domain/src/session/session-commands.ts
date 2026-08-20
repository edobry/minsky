/**
 * Session Commands
 *
 * Session operations that accept session parameters.
 */

import { MinskyError, NothingToCommitError } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { safeShellQuote } from "@minsky/shared/exec";
import { raceAgainstTimeout } from "@minsky/shared/timeout";
import type { AskRepository } from "../ask/repository";
import { closeAskAsResolved } from "../ask/close-as-resolved";
import { isActionCovered, loadAllPolicySources } from "../ask/policy";
import { emitSystemEventFromProvider } from "../events/emit-best-effort";
import type { PersistenceProvider } from "../persistence/types";
import type { TokenProvider } from "../auth/token-provider";
import type { GitServiceInterface } from "../git/types";
import type { PushWithConfirmationResult } from "../git/push-operations";
import { checkFreshnessCas, cleanupFreshnessMarker } from "./freshness-marker";
import {
  computeCommitDeletionStats,
  DEFAULT_MASS_DELETION_THRESHOLD,
} from "../git/commit-deletion-stats";
import {
  resolveDestructiveOverride,
  isValidDestructiveOverride,
  recordDestructiveOverride,
} from "../safety/destructive-override";
import { restoreUpdateStashAfterCommit, type StashRestoreOutcome } from "./session-stash-restore";

/**
 * Error thrown when the branch-freshness CAS check (mt#1522) detects that
 * `origin/main` advanced between the freshness hook's allow decision and
 * `session_commit`'s push. Defined here (rather than in `freshness-marker.ts`)
 * so the marker module stays free of `errors/` imports — that module is also
 * imported by the `.claude/hooks/check-branch-fresh.ts` hook for its write
 * helper, and dragging app-domain transitive deps into the hook is a
 * regression risk per PR #963 R2 BLOCKING #2.
 *
 * Carries a stable `code` so UX/policy/telemetry layers can distinguish a
 * CAS-prevented push from other commit failures programmatically.
 */
export class FreshnessCasError extends MinskyError {
  readonly code: "FRESHNESS_CAS_FAILED" = "FRESHNESS_CAS_FAILED";
  constructor(
    message: string,
    public readonly capturedSha: string,
    public readonly currentSha: string,
    public readonly mainRef: string
  ) {
    super(message);
  }
}

/**
 * Thrown when the COMMIT phase of `sessionCommit` (staging + `git commit`,
 * which synchronously runs the `.husky/pre-commit` hook chain) exceeds its
 * wall-clock bound (mt#3049).
 *
 * Root cause (mt#3049 spec Outcome, investigated 2026-07-22): NEITHER
 * `commitImpl` (git-core-operations.ts, `git commit`) NOR `pushImpl`
 * (push-operations.ts, `git push`) — the two subprocess calls this file's
 * `sessionCommit` drives — ever carried a wall-clock timeout. Every
 * INDIVIDUAL step inside `src/hooks/pre-commit.ts`'s ~14-step pipeline IS
 * individually bounded (5s-120s each via `execAsync`'s own `timeout` option
 * or `Bun.spawnSync`'s `timeout`), but there was no bound on the pipeline AS
 * A WHOLE, and the `git commit` subprocess call that runs it had no bound of
 * its own — so the pipeline's aggregate cost (ordinarily well under a few
 * minutes, per a step-by-step reading of every timeout in that file) had no
 * ceiling below the MCP transport's own last-resort client-side abort
 * (~1800s / 30 minutes — the exact duration observed in the mt#3003
 * incident this task originated from, and previously reported as a bare
 * "1800s client abort" by mt#2711, still open/TODO at the time this class
 * shipped). This class turns that silent, opaque 1800s hang into an
 * immediate, structured, phase-named error.
 *
 * Deliberate limitation: this does NOT kill the underlying git/hook
 * subprocess. `commitChangesFromParams` -> `commitImpl` -> `execAsync`
 * (`child_process.exec`) has no abort/cancellation hook threaded through
 * this call chain, so an abandoned commit attempt keeps running in the
 * background after this error is thrown — bounding the CALLER's wait, not
 * terminating the underlying work. Forcibly killing it would require
 * migrating that chain to `Bun.spawn` (as `gitShowStagedBytes`/`runGitArgv`
 * in pre-commit.ts already do for a couple of call sites), which is a
 * larger, more invasive change than this task's scope covers — tracked as
 * possible follow-up if silent background completion proves to cause real
 * problems (e.g. a retried commit racing the abandoned one over
 * `.git/index.lock`).
 */
export class SessionCommitPhaseTimeoutError extends MinskyError {
  readonly code: "SESSION_COMMIT_PHASE_TIMEOUT" = "SESSION_COMMIT_PHASE_TIMEOUT";
  constructor(
    message: string,
    public readonly phase: "commit" | "push",
    public readonly timeoutMs: number
  ) {
    super(message);
  }
}

/**
 * Thrown when `sessionCommit`'s mass-deletion sanity gate (mt#3021 SC3)
 * refuses to push a commit whose staged delta deleted more than
 * `DEFAULT_MASS_DELETION_THRESHOLD` tracked files, absent a valid
 * destructive-override reason. The underlying commit has already landed
 * LOCALLY at this point (see this file's `sessionCommit` — the gate runs
 * after commit, before push, per the mt#3021 spec's "placement: push time,
 * not commit time" design decision) — it is NOT pushed, and per that same
 * design decision a local un-pushed commit is cheap to recover (amend /
 * reset / redo), so refusing here does not lose work.
 */
export class MassDeletionGuardError extends MinskyError {
  readonly code: "MASS_DELETION_GUARD_TRIPPED" = "MASS_DELETION_GUARD_TRIPPED";
  constructor(
    message: string,
    public readonly deletionCount: number,
    public readonly threshold: number,
    public readonly sampleDeletedPaths: string[]
  ) {
    super(message);
  }
}

/**
 * Default wall-clock bound for the COMMIT phase (staging + `git commit` +
 * the synchronous `.husky/pre-commit` hook chain it runs) — mt#3049.
 *
 * Grounded in a step-by-step reading of every individual timeout in
 * `src/hooks/pre-commit.ts` (the file this phase ultimately blocks on):
 * summing every step's own bound (typecheck 60s x2 targets, eslint 120s,
 * gitleaks 30s, related-tests 75s, rules/compile-check 30s x N targets,
 * variable-naming 30s, dockerfile-copy-regen 15s, completion-manifest 15s,
 * plus several 5s checks) comes to roughly 6-7 minutes in the worst case
 * where EVERY step ran close to its own ceiling — which would be unusual in
 * a passing run (near-timeout usually means near-FAILURE, which returns
 * immediately). 10 minutes gives comfortable headroom above that worst-case
 * sum while still firing an order of magnitude faster than the 1800s (30m)
 * MCP-transport abort this class replaces, so a genuinely stuck commit is
 * diagnosable within the same call instead of only after the client gives up.
 */
export const DEFAULT_COMMIT_PHASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default wall-clock bound for the PUSH phase — mt#3049, raised from 2 to 10
 * minutes by mt#3480.
 *
 * The original docblock read "`git push` — no hooks fire on this side, so cost
 * is dominated by network round-trip". **That is factually wrong**, and the
 * 2-minute value followed from it. `.husky/pre-push` (mt#2716) fires on exactly
 * this side and runs the full local test suite — measured 2026-07-31 at 209.71s
 * for the main run (10865 tests across 770 files) plus ~19 further suites. Cost
 * is dominated by the test gate, not the network, and a healthy push here takes
 * ~4 minutes.
 *
 * So the bound was shorter than the gate it had to wait for, and `session.commit`
 * pushes timed out routinely — the incident that produced mt#3480 needed explicit
 * 420s/600s overrides on every commit to get its own changes pushed.
 *
 * Kept in step with `DEFAULT_PUSH_CONFIRM_TIMEOUT_MS` (`git/push-operations.ts`),
 * which was raised for the same reason: the two are independently configurable
 * but describe the same physical wait, and letting them diverge would mean a
 * push bounded differently depending on which caller issued it.
 */
export const DEFAULT_PUSH_PHASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * mt#3177: `raceAgainstTimeout` moved to `@minsky/shared/timeout` so the git
 * domain package (`push-operations.ts`) can share the exact same bounded-race
 * primitive without introducing a git -> session layering violation (git is
 * lower-level than session; this file already imports FROM `../git`, never
 * the reverse). Re-exported here unchanged so existing imports from
 * `./session-commands` (this file's own callers and its test suite) keep
 * working without a call-site change.
 */
export { raceAgainstTimeout };

/**
 * Which credential path a session-commit push used (mt#2897).
 *
 * - "app-token": GitHub App installation token resolved and used — the path
 *   that reliably triggers pull_request workflows (mt#1477).
 * - "keychain-unconfigured": no service account is configured; system
 *   credentials are the expected path for this install (not a failure).
 * - "keychain-fallback": the App-token path could not complete the push —
 *   either token resolution failed, or (mt#3210) a successfully-minted
 *   token was itself denied by GitHub (403) because the App installation's
 *   `contents` permission does not include write access. Either way the
 *   push falls back to system keychain credentials, which may silently
 *   fail to trigger pull_request workflows (the intermittent CI-miss class
 *   in docs/ci-check-never-ran-playbook.md §Root cause).
 */
export type PushCredentialPath = "app-token" | "keychain-unconfigured" | "keychain-fallback";

export interface PushCredentialResolution {
  authToken?: string;
  credentialPath: PushCredentialPath;
  /** Present only on the "keychain-fallback" path: why token resolution failed. */
  failureReason?: string;
}

/**
 * Resolve the credential for a session-commit push, loudly (mt#2897).
 *
 * The fallback path emits a structured warning with a stable event name
 * (`session.commit.push_credential_fallback`) and the failure reason, and the
 * resolution is returned to the caller so `credentialPath` can be surfaced in
 * the commit result — a convergence-driving agent can then anticipate a
 * possible workflow-trigger drop instead of discovering it via zero check
 * runs. The unconfigured path is deliberately quiet: keychain credentials are
 * the expected push auth when no App service account exists, and warning on
 * every commit for those installs would be noise.
 */
export async function resolvePushCredential(
  tokenProvider: Pick<TokenProvider, "isServiceAccountConfigured" | "getToken"> | undefined,
  deps: {
    session?: string;
    warn?: (message: string, context?: Record<string, unknown>) => void;
  } = {}
): Promise<PushCredentialResolution> {
  const warn = deps.warn ?? log.warn;
  if (!tokenProvider?.isServiceAccountConfigured()) {
    return { credentialPath: "keychain-unconfigured" };
  }
  try {
    const authToken = await tokenProvider.getToken("implementer");
    return { authToken, credentialPath: "app-token" };
  } catch (tokenErr) {
    const failureReason = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
    warn(
      "[session.commit] App-token resolution failed; pushing with system keychain credentials — pull_request workflows may not trigger (mt#2897)",
      {
        event: "session.commit.push_credential_fallback",
        session: deps.session,
        reason: failureReason,
      }
    );
    return { credentialPath: "keychain-fallback", failureReason };
  }
}

/**
 * Detects a GitHub permission-denied push failure — the signature the
 * App-token push path produces when the App installation's `contents`
 * permission does not include write access (mt#3210, root cause confirmed
 * via a live `GET /app` read against the `minsky-ai[bot]` App: permissions
 * resolved to `{contents: "read", ...}`, not `write`). Matched against BOTH
 * halves of the field-observed denial together — `git`'s own rejection
 * message ("remote: Permission ... denied to <bot>.") AND the generic HTTP
 * status line ("The requested URL returned error: 403"), which appear
 * together in the same failure per mem#721.
 *
 * mt#3210 R1: a bare `403` is deliberately NOT sufficient on its own. A 403
 * can also mean an INTENTIONAL denial unrelated to the missing-contents-write
 * gap — e.g. branch protection or another repo-level restriction rejecting
 * the App. Falling back to the operator's personal keychain credentials in
 * that case would silently convert a deliberate block into a successful push
 * under a different identity, which is worse than the push failing visibly.
 * Requiring the permission-denial phrase to co-occur with the 403 status
 * line keeps the detector scoped to the specific failure it exists to catch.
 */
export function isPermissionDeniedPushError(message: string | undefined): boolean {
  if (!message) return false;
  const hasPermissionDenialPhrase = /permission[\s\S]*denied/i.test(message);
  const hasStatusLine = /\b403\b/.test(message);
  return hasPermissionDenialPhrase && hasStatusLine;
}

/**
 * A session-commit push, wrapped with automatic fallback to system keychain
 * credentials when the resolved App-token push is denied (mt#3210).
 *
 * The App-token push path (mt#1477) can fail two structurally different
 * ways: (1) token *minting* itself throws — `resolvePushCredential`'s
 * pre-existing `keychain-fallback` path (mt#2897) already handles this by
 * never attempting the push with a token at all; or (2) minting succeeds
 * but the push itself is denied because the App installation lacks
 * `contents: write`. Case (2) previously surfaced as a returned
 * `pushed:false` result the caller had to notice and retry by hand — the
 * exact defect mt#3210 exists to fix, observed at a measured 8-of-8 rate
 * across three independent dispatches on 2026-07-25. This function folds
 * case (2) into the same fallback vocabulary as case (1), reusing the
 * `session.commit.push_credential_fallback` event: from the caller's
 * perspective both cases land in the same place — the push succeeded, but
 * via a credential that may not reliably trigger `pull_request` workflows
 * (mt#1477), so the same "verify CI fired" discipline applies either way.
 *
 * Deliberately conservative: the retry fires ONLY when (a) the ORIGINAL
 * attempt used the app-token path, (b) it did not merely time out
 * (`pushOutcome.pushTimedOut` — an ambiguous outcome mt#3177 already
 * verifies against the remote directly; retrying blind on top of that would
 * risk a redundant concurrent push against a possibly-still-running
 * background attempt), and (c) the failure text matches the permission-
 * denied signature — an unrelated push failure (rejected non-fast-forward,
 * network error) is surfaced as-is rather than masked by a same-content
 * keychain retry.
 */
export async function pushSessionCommitWithFallback(
  tokenProvider: Pick<TokenProvider, "isServiceAccountConfigured" | "getToken"> | undefined,
  pushParams: { repo: string; branch?: string },
  config: { pushTimeoutMs: number; session?: string },
  deps: {
    pushFromParamsWithConfirmation: (
      params: {
        repo?: string;
        remote?: string;
        force?: boolean;
        debug?: boolean;
        authToken?: string;
      },
      config?: { pushTimeoutMs?: number; verifyTimeoutMs?: number; branch?: string }
    ) => Promise<PushWithConfirmationResult>;
    warn?: (message: string, context?: Record<string, unknown>) => void;
  }
): Promise<
  PushWithConfirmationResult & { credentialPath: PushCredentialPath; appTokenPushError?: string }
> {
  const warn = deps.warn ?? log.warn;
  const pushCredential = await resolvePushCredential(tokenProvider, { session: config.session });

  const pushOutcome = await deps.pushFromParamsWithConfirmation(
    { repo: pushParams.repo, authToken: pushCredential.authToken },
    { pushTimeoutMs: config.pushTimeoutMs, branch: pushParams.branch }
  );

  const appTokenWasDenied =
    pushCredential.credentialPath === "app-token" &&
    !pushOutcome.pushed &&
    !pushOutcome.pushTimedOut &&
    isPermissionDeniedPushError(pushOutcome.pushError);

  if (!appTokenWasDenied) {
    // mt#3264: an App-token push that FAILED but did not match the denial
    // signature above is a case the fallback deliberately declines to handle —
    // and until now it declined silently, indistinguishable in the logs from a
    // fallback that never ran at all. The canonical instance is a server-side
    // rejection (`! [remote rejected] ... without 'workflows' permission`),
    // which carries neither a 403 nor the word "denied".
    //
    // The remedy is legibility, NOT a wider trigger. Swapping to keychain
    // credentials on any rejection would convert a deliberate server-side block
    // into a successful push under a DIFFERENT IDENTITY — which is what the
    // narrowness exists to prevent (mem#721), and what the accepted
    // dual-identity decision record forbids: "don't conflate dimensions just
    // because a fallback is convenient." So name the reason and stop; the
    // caller already receives it as `pushError`.
    if (pushCredential.credentialPath === "app-token" && pushOutcome.pushError) {
      warn(
        "[session.commit] App-token push failed without a permission-denial signature; " +
          "keychain fallback deliberately NOT attempted (mt#3264) — pushing under a different " +
          "identity could mask a server-side block. Git's reason is in `pushError`.",
        {
          event: "session.commit.push_fallback_declined",
          session: config.session,
          stage: "push-failed",
          reason: pushOutcome.pushError,
        }
      );
    }
    return { ...pushOutcome, credentialPath: pushCredential.credentialPath };
  }

  warn(
    "[session.commit] App-token push denied (403); retrying with system keychain credentials — pull_request workflows may not trigger (mt#1477/mt#3210)",
    {
      event: "session.commit.push_credential_fallback",
      session: config.session,
      stage: "push-denied",
      reason: pushOutcome.pushError,
    }
  );

  const retryOutcome = await deps.pushFromParamsWithConfirmation(
    { repo: pushParams.repo },
    { pushTimeoutMs: config.pushTimeoutMs, branch: pushParams.branch }
  );

  return {
    ...retryOutcome,
    credentialPath: "keychain-fallback",
    appTokenPushError: pushOutcome.pushError,
  };
}

// mt#3212: the hand-written `SessionPrParams` interface that used to live here
// was deleted, along with the `sessionPrParamsSchema`/`SessionPrParams` pair in
// `../schemas/session.ts`. Both were dead: this one served the `sessionPr()`
// wrapper deleted below, and neither had a consumer left. The live PR contract
// is `SessionPRParameters` (`../schemas/session-schemas.ts`), which
// `session-pr-operations.ts` parses with — same treatment mt#3211 gave the
// hand-written `SessionUpdateParams` noted below.

// ❌ DELETED: sessionPr() wrapper function - redundant duplicate
// This function was a wrapper around sessionPrFromParams (legacy implementation).
// All callers should use the modern sessionPr() from ./commands/pr-command.ts instead.

// mt#3211: the hand-written `SessionUpdateParams` interface that used to live here
// was deleted — it was a second, independently-maintained definition of the same
// name as `packages/domain/src/schemas/session.ts`'s `SessionUpdateParams`
// (`z.infer<typeof sessionUpdateParamsSchema>`), had zero consumers, and let a
// parameter (mt#3205's `pushTimeoutMs`) go missing from it silently because
// nothing pointed here. The schema-derived type in `../schemas/session` is now
// the single source of truth; import it from there.

/**
 * Pure domain interface for session approval
 */
export interface SessionApproveParams {
  session: string; // ✅ ALWAYS required
}

/**
 * Pure session approve domain function
 */
export async function pureSessionApprove(
  params: SessionApproveParams,
  sessionProvider: import("./types").SessionProviderInterface
): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session approve command", { session: params.session });

  const { approveSessionPr } = await import("./session-pr-approval-operations.js");

  try {
    const _result = await approveSessionPr(
      {
        session: params.session,
      },
      { sessionDB: sessionProvider }
    );

    return {
      success: true,
      message: "Session approved successfully",
    };
  } catch (error) {
    log.debug("Pure session approve failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session,
    });
    throw error;
  }
}

/**
 * Structured result of a `sessionCommit` call (mt#3049). Carries `pushed` as
 * its own boolean specifically so a caller can distinguish "committed but
 * push failed/timed out" (`success: true, commitHash: <sha>, pushed: false,
 * pushError/pushTimedOut set`) from a genuine end-to-end success
 * (`pushed: true`) or a hard failure (thrown, not returned) — instead of an
 * opaque timeout that reveals neither outcome. See the mt#3049 spec Outcome
 * for the root-cause investigation this shape closes the gap for.
 */
export interface SessionCommitResult {
  success: boolean;
  nothingToCommit?: boolean;
  /**
   * Pre-existing convention (unchanged by mt#3049, documented here per
   * review R1): SHORT hash, parsed from `git commit`'s own stdout banner
   * (`extractCommitHash` in git-with-deps.ts prefers the `[branch abc1234]`
   * form). `shortHash` below is the same value via a different derivation
   * path (`git log -1 --format=%h`) and is redundant with this field for
   * every current caller — kept for backward compatibility rather than
   * removed. If a caller needs the unambiguous FULL 40-char SHA, resolve it
   * separately (e.g. `git rev-parse <commitHash>`); this field is not it.
   */
  commitHash: string | null;
  shortHash?: string;
  subject?: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;
  message: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  files?: Array<{ path: string; status: string }>;
  pushed: boolean;
  credentialPath?: PushCredentialPath;
  /**
   * mt#3660: present only when this commit found work parked by an earlier
   * CONFLICTED `session_update` and acted on it. `restored: true` means the work
   * is back in the working tree — UNCOMMITTED, and deliberately not part of this
   * commit. `restored: false` means it is still parked, and `stashRef` /
   * `parkedFiles` name where; a caller must not read this commit as carrying it.
   *
   * Absent is the normal case (nothing was parked).
   */
  stashRestore?: StashRestoreOutcome;
  /**
   * mt#3049: set (with `pushed: false`) when the commit itself succeeded but
   * the push phase failed with a thrown error — the underlying error's
   * message, so the caller can see WHY without the exception itself having
   * discarded the commit sha (the pre-fix behavior: a thrown push error
   * propagated raw, losing the fact the commit had already landed locally).
   */
  pushError?: string;
  /**
   * mt#3049: set (with `pushed: false`, no `pushError`) when the push phase
   * exceeded `DEFAULT_PUSH_PHASE_TIMEOUT_MS` (or an injected override)
   * rather than failing outright — distinguishes "push is still running in
   * the background, outcome unknown" from "push actively failed."
   */
  pushTimedOut?: boolean;
  /**
   * mt#3177: set (with `pushed: true`) when the push phase timed out but a
   * follow-up remote-ref check (`git ls-remote`, see `verifyRemoteRefAdvanced`
   * in `push-operations.ts`) confirmed the remote branch head already
   * matches the local commit — the push landed server-side even though this
   * call's own confirmation did not. Distinguishes a slow-but-successful
   * push from the ordinary fast-success path (which never sets this field).
   */
  pushConfirmedVia?: "remote-check";
  /**
   * mt#3177: set (with `pushed: false`) when the push phase timed out AND a
   * follow-up remote-ref check did NOT confirm the push landed (either the
   * remote genuinely has not advanced, or the verification check itself was
   * inconclusive — network failure, no matching ref, or its own timeout).
   * This is the explicit "we do not know" state: unlike a bare
   * `pushTimedOut: true`, which a careless caller could still misread
   * against a `pushed: false` it never inspects, `pushUnconfirmed: true` is
   * the field intended to be checked directly — no consumer should read it
   * as, or adjacent to, success.
   */
  pushUnconfirmed?: boolean;
  /**
   * mt#3210: set (alongside `credentialPath: "keychain-fallback"`, whether
   * `pushed` ends up true or false) when the App-token push attempt was
   * denied (403) and `pushSessionCommitWithFallback` retried via system
   * keychain credentials. Preserves the original denial for diagnosis even
   * though the caller may see a successful `pushed: true` overall outcome —
   * the retry succeeding does not mean the App-token permission gap
   * (`contents: read` on the installation, not `write`) has been fixed.
   */
  appTokenPushError?: string;
  /**
   * mt#3049: true when this call found an existing LOCAL commit already
   * ahead of `origin/<branch>` on an otherwise-clean tree (the resumable
   * path — a prior call's push phase failed/timed out after its commit
   * landed) and completed the pending push, rather than creating a NEW
   * commit. `commitHash`/metadata describe that pre-existing HEAD commit.
   */
  resumedPush?: boolean;
}

/**
 * Session commit command - commits and pushes changes within a specific session
 *
 * Note: Always pushes after commit - in session context these operations should be atomic
 */
export async function sessionCommit(
  params: {
    session: string;
    message: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
    noFiles?: boolean;
    /** mt#3049: internal override for tests — see DEFAULT_COMMIT_PHASE_TIMEOUT_MS. */
    commitTimeoutMs?: number;
    /** mt#3049: internal override for tests — see DEFAULT_PUSH_PHASE_TIMEOUT_MS. */
    pushTimeoutMs?: number;
    /**
     * mt#3021 SC3: justification required to push a commit whose staged
     * delta trips the mass-deletion sanity gate (see
     * `MassDeletionGuardError`). Threaded through the shared
     * destructive-override contract (`../safety/destructive-override.ts`).
     */
    overrideReason?: string;
  },
  sessionProvider: import("./types").SessionProviderInterface,
  askRepository?: AskRepository,
  tokenProvider?: TokenProvider,
  persistenceProvider?: PersistenceProvider
): Promise<SessionCommitResult> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session commit command", {
    session: params.session,
    message: params.message,
  });

  // Enforce merged-PR-freeze invariant BEFORE Ask emission.
  // Design rationale: assertSessionMutable fires first by design. Frozen sessions
  // (those whose PR has been merged) cannot commit, so capturing them as Ask events
  // would route non-events through the policy system. ADR §Detection records actual
  // commits, not attempts on frozen sessions.
  //
  // Reviewer note: R1 and R2 both raised "emit before mutable check" as a finding.
  // That finding is explicitly dismissed: the ordering is intentional. Frozen sessions
  // cannot produce real commits; an Ask emitted for one would be a false positive.
  const { assertSessionMutable } = await import("./session-mutability.js");
  const sessionRecordForFreeze = await sessionProvider.getSession(params.session);
  if (sessionRecordForFreeze) {
    assertSessionMutable(sessionRecordForFreeze, "commit changes");
  }

  const { commitChangesFromParams, pushFromParamsWithConfirmation, createGitService } =
    await import("../git");

  // Resolve session to repo path at this boundary (needed for clean-tree check below)
  const workdir = await sessionProvider.getSessionWorkdir(params.session);

  // mt#1522 / PR #963 R1 BLOCKING #5: marker cleanup must run on EVERY exit
  // path of sessionCommit (clean-tree early return, NothingToCommitError
  // early return, commit failure, CAS abort, push failure, success). Wrapping
  // the entire post-workdir body in try/finally with cleanup in finally
  // gives that guarantee — the previous inline cleanup only after a
  // successful CAS check left stale markers on early returns.
  try {
    // Detect clean working tree up front — skip Ask emission and return early when
    // there is nothing to commit. ADR §Detection: "every agent-initiated commit" means
    // actual commits, not attempts on a clean tree.
    //
    // Carve-out: when params.amend is true, the commit may legitimately update only
    // the commit message without new file changes. In that case the working tree is
    // clean by design, so we must NOT short-circuit — the amend must be allowed to
    // proceed even when hasUncommittedChanges returns false.
    const sessionIdToUse = params.session;
    let isCleanTree = false;
    try {
      const gitService = createGitService();
      const hasChanges = await gitService.hasUncommittedChanges(workdir);
      isCleanTree = !hasChanges;
    } catch (probeErr) {
      // If we cannot determine tree state (e.g. not a git repo yet), let the
      // downstream commit attempt proceed and handle NothingToCommitError there.
      // Surface the probe failure (don't silently swallow): if the tree turns out
      // to actually be clean, the Ask emitted below is a benign false positive
      // for that rare path, but operators need visibility into why detection failed.
      log.warn(
        `[session.commit] hasUncommittedChanges probe failed; proceeding with commit attempt: ${
          probeErr instanceof Error ? probeErr.message : String(probeErr)
        }`
      );
    }

    if (!params.amend && isCleanTree) {
      // When noFiles is true, the caller wants an empty commit to wake a webhook
      // or produce an audit-trail commit. Use --allow-empty and proceed to push.
      // When noFiles is false (default), return the existing no-op result —
      // UNLESS (mt#3049) the local branch already carries a commit that never
      // reached origin (a prior call's push phase failed/timed out after its
      // commit landed). That's the resumable path: a repeat session_commit
      // call on an otherwise-clean tree should complete the pending push
      // instead of silently reporting "nothing to commit" forever.
      if (!params.noFiles) {
        const resumed = await tryResumePendingPush(workdir, {
          session: params.session,
          tokenProvider,
          pushTimeoutMs: params.pushTimeoutMs ?? DEFAULT_PUSH_PHASE_TIMEOUT_MS,
        });
        if (resumed) {
          log.debug("Resumed a pending push on an otherwise-clean tree", {
            session: params.session,
            pushed: resumed.pushed,
          });
          return resumed;
        }
        log.debug("Nothing to commit in session (clean working tree)", { session: params.session });
        return {
          success: true,
          nothingToCommit: true,
          commitHash: null,
          message: "Nothing to commit, working tree clean",
          pushed: false,
        };
      }
      log.debug("Creating empty commit (noFiles=true, clean tree) for webhook wake", {
        session: params.session,
      });
    }

    // Detection-time policy consult (mt#2935; ADR-008 §Router moved to the
    // emit site). A routine commit under a standing auto-commit policy is a
    // statically-resolved decision point — record it as an audit EVENT, not
    // an authorization.approve Ask. The Ask is created ONLY when policy is
    // silent (the genuine escalation) or when the covered-path event row
    // could not actually be persisted (fail toward the ask — the action must
    // never go silently unrecorded). Everything here is best-effort and never
    // blocks the commit. mt#2593: on the uncovered path, capture the created
    // Ask's id so it can be closed once the commit lands (below).
    let commitAuthAskId: string | undefined;
    if (askRepository || persistenceProvider) {
      const requestor =
        sessionRecordForFreeze?.agentId ?? `minsky.session-commit:session:${sessionIdToUse}`;

      let policyCoveredAndRecorded = false;
      try {
        // The session workdir is a clone of the repo, so its CLAUDE.md and
        // project rules ARE the policy corpus for this action.
        const sources = await loadAllPolicySources(workdir);
        const coverage = isActionCovered(["commit", "push"], sources);
        if (coverage.covered && coverage.citation) {
          const recorded = await emitSystemEventFromProvider(persistenceProvider, {
            eventType: "authorization.policy_covered",
            payload: {
              action: "commit",
              citationSource: coverage.citation.source,
              ...(coverage.citation.lineRange
                ? { citationLines: coverage.citation.lineRange }
                : {}),
              commitMessage: params.message,
            },
            actor: requestor,
            relatedTaskId: sessionRecordForFreeze?.taskId,
            relatedSessionId: sessionRecordForFreeze?.sessionId,
          });
          if (recorded) {
            policyCoveredAndRecorded = true;
          } else {
            log.debug(
              "sessionCommit: policy covers commit but audit event was not persisted; falling back to Ask emission",
              { session: params.session, citationSource: coverage.citation.source }
            );
          }
        }
      } catch (policyErr: unknown) {
        log.warn(
          "sessionCommit: detection-time policy consult failed; falling back to Ask emission (best-effort)",
          {
            session: params.session,
            error: policyErr instanceof Error ? policyErr.message : String(policyErr),
          }
        );
      }

      if (!policyCoveredAndRecorded && askRepository) {
        try {
          const commitAuthAsk = await askRepository.create({
            kind: "authorization.approve",
            classifierVersion: "v1",
            requestor,
            parentTaskId: sessionRecordForFreeze?.taskId,
            parentSessionId: sessionRecordForFreeze?.sessionId,
            title: `Commit authorization: ${params.message.slice(0, 80)}`,
            question: `Authorize commit in session ${params.session}: "${params.message}"`,
            metadata: {
              commitMessage: params.message,
              stagedFiles: params.all ? "all" : "manual-staged",
            },
          });
          commitAuthAskId = commitAuthAsk.id;
        } catch (askErr: unknown) {
          log.warn("sessionCommit: failed to emit authorization.approve Ask (best-effort)", {
            session: params.session,
            error: askErr instanceof Error ? askErr.message : String(askErr),
          });
        }
      }
    }

    try {
      // Commit changes using session-scoped git command
      let commitResult!: { commitHash: string; message: string };
      const commitTimeoutMs = params.commitTimeoutMs ?? DEFAULT_COMMIT_PHASE_TIMEOUT_MS;
      try {
        // When noFiles is true and tree is clean, use --allow-empty so that a real
        // commit is created even without staged changes. This is the webhook-wake
        // mechanism: the push triggers pull_request.synchronize.
        const allowEmpty = params.noFiles === true && isCleanTree && !params.amend;
        // mt#2635: route the empty-commit case through the SAME
        // commitChangesFromParams -> commitImpl path used for real commits,
        // instead of a bespoke `gitService.execInRepository(...)` call. The
        // prior bespoke call went through `execInRepositoryImpl`, which
        // catches any subprocess failure and re-throws a brand-new
        // `MinskyError` carrying only a one-line "cleaned" summary — NOT the
        // original error's `.stdout`/`.stderr`. That meant a hook failure on
        // the allow-empty path could never be classified by
        // `classifyHookFailure` (workflow-commands.ts), which requires
        // `.stdout`/`.stderr` on the caught error, so the operator only ever
        // saw an opaque one-liner with no diagnostic detail. `commitImpl`
        // re-throws the ORIGINAL execAsync error unmodified on failure, so
        // routing through it here restores full hook-output propagation for
        // the allow-empty path — same as the real-commit path already had.
        //
        // mt#3049: bounded via raceAgainstTimeout — see
        // SessionCommitPhaseTimeoutError's doc comment for the root-cause
        // investigation this closes (NEITHER this call NOR the push call
        // below previously carried any wall-clock bound at all).
        const raced = await raceAgainstTimeout(
          commitChangesFromParams({
            message: params.message,
            repo: workdir,
            all: params.all,
            amend: params.amend,
            // A clean tree has nothing to stage; skip the staging step outright
            // rather than let it run as a (harmless but pointless) no-op.
            noStage: allowEmpty ? true : params.noStage,
            allowEmpty,
          }),
          commitTimeoutMs
        );
        if (raced.timedOut) {
          throw new SessionCommitPhaseTimeoutError(
            `session_commit: commit phase (staging + pre-commit hooks) exceeded ${commitTimeoutMs}ms ` +
              `without completing. The underlying git commit process may still be running in the ` +
              `background — check \`git log\` / working-tree state before retrying to avoid a ` +
              `duplicate commit attempt.`,
            "commit",
            commitTimeoutMs
          );
        }
        commitResult = raced.value;
      } catch (commitErr: unknown) {
        // Handle "nothing to commit" gracefully — not an error condition
        if (commitErr instanceof NothingToCommitError) {
          log.debug("Nothing to commit in session", { session: params.session });
          return {
            success: true,
            nothingToCommit: true,
            commitHash: null,
            message: "Nothing to commit, working tree clean",
            pushed: false,
          };
        }
        throw commitErr;
      }

      // mt#1522: CAS check on origin/main SHA before push.
      //
      // The branch-freshness hook (mt#1483) captures origin/main's SHA at
      // allow time and writes it to `.git/.minsky-freshness-sha`. Here we
      // re-fetch and verify the SHA hasn't advanced. If it has, the agent
      // would build on stale base — same shape of bug the freshness hook
      // exists to prevent, just at a smaller (~seconds) time scale.
      //
      // §7b TOCTOU enumeration on this CAS pattern:
      //   - Read atomicity: marker is one read; current-SHA is one
      //     `git rev-parse` after fetch. PASS.
      //   - Decision-action gap: between this CAS pass and the push that
      //     follows, origin/main can advance again. ACCEPT — irreducible
      //     (no remote locking on origin/main without server-side
      //     enforcement) AND FF-conflict-preserving (push to
      //     origin/<branch> doesn't conflict with origin/main advances).
      //     The push-duration window is ms-class, orders of magnitude
      //     smaller than the seconds-class gap we're closing.
      //   - Stale-read at read time: forced fresh `git fetch` before SHA
      //     resolve. PASS.
      //
      // When MINSKY_SKIP_FRESHNESS=1, the hook exits before writing a
      // marker; checkFreshnessCas reads no marker and bypasses, mirroring
      // the override semantics through to push.
      const casGitService = createGitService();
      const casResult = await checkFreshnessCas(workdir, {
        fetchOrigin: async (dir) => {
          try {
            await casGitService.execInRepository(dir, "git fetch origin --prune --no-tags --quiet");
            return true;
          } catch {
            return false;
          }
        },
        resolveRefSha: async (dir, ref) => {
          try {
            // Defense-in-depth (PR #963 R2 BLOCKING #1, corrected mt#3049):
            // `--verify --end-of-options` prevents git from interpreting
            // `ref` as an option even if a future regex regression were to
            // admit a leading-`-` value (SAFE_REF_RE already forbids
            // leading `-`; this keeps the call safe under any validator
            // drift), WITHOUT the bug the original `--` separator had:
            // `git rev-parse -- <ref>` treats `--`-terminated arguments as
            // PATHSPECS, not revisions, so it never actually resolved `ref`
            // to a SHA — it echoed the literal string back, which always
            // failed the SHA regex below and made `resolveRefSha` return
            // `null` on every call. `checkFreshnessCas` (freshness-marker.ts)
            // treats a `null` resolution as `bypass: "ref-unresolvable"` —
            // meaning the mt#1522 branch-freshness CAS check was silently
            // bypassing on every single session_commit push since it
            // shipped. `--end-of-options` (git >=2.24) blocks a leading-`-`
            // string from being parsed as an option WITHOUT the pathspec
            // reinterpretation `--` causes, verified empirically (git
            // 2.49): `git rev-parse --verify --end-of-options origin/main`
            // resolves to a real SHA; `git rev-parse --verify
            // --end-of-options -- <ref>` (both together) or `-1` /
            // `--upload-pack=x` as `ref` all still fail cleanly with "fatal:
            // Needed a single revision" (exit 128), not option injection.
            // mt#1742 R1: wrap `ref` with safeShellQuote rather than relying on
            // the doc-asserted SAFE_REF_RE validation at this call site. Same
            // shell-safety class as the commit-message fix; consistency at
            // every interpolation in this file's git templates.
            const out = await casGitService.execInRepository(
              dir,
              `git rev-parse --verify --end-of-options ${safeShellQuote(ref)}`
            );
            const sha = out.trim();
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
          } catch {
            return null;
          }
        },
      });
      // Cleanup happens unconditionally in the outer `finally` block — see
      // the bottom of sessionCommit. We don't clean up here so the casResult
      // remains the source of truth for the throw decision.
      if (!casResult.ok) {
        throw new FreshnessCasError(
          `Branch-freshness CAS check failed: ${casResult.reason ?? "(no reason)"}`,
          casResult.capturedSha ?? "(unknown)",
          casResult.currentSha ?? "(unknown)",
          // mt#3049 review R1: checkFreshnessCas now threads `mainRef` back
          // (it already had the marker in scope) instead of forcing the
          // caller to re-read the marker or lose the ref entirely.
          casResult.mainRef ?? "(unknown)"
        );
      }

      // mt#2593: the commit succeeded (CAS passed too), so the commit-
      // authorization Ask emitted above is resolved — close it best-effort so
      // it never lingers in the operator's suspended queue. On commit FAILURE
      // we throw before reaching here, leaving the Ask open (the genuine
      // attention-worthy case).
      //
      // mt#3049: moved up from AFTER a successful push (see git blame) — the
      // Ask authorizes the COMMIT, which has already landed at this point
      // regardless of whether the push below succeeds. The previous ordering
      // left the Ask open forever whenever push failed, even though the
      // authorized action (the commit) had already completed.
      if (askRepository && commitAuthAskId) {
        try {
          await closeAskAsResolved(askRepository, commitAuthAskId, {
            responder: "system:commit-landed",
            payload: { commitHash: commitResult.commitHash },
          });
        } catch (closeErr: unknown) {
          log.debug("sessionCommit: failed to close commit-authorization Ask (best-effort)", {
            session: params.session,
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
      }

      // Collect commit metadata and changed files — independent of push
      // outcome below, since the commit itself already landed locally.
      const gitService = createGitService();

      // mt#3021 SC3: mass-deletion sanity gate. Runs AFTER commit, BEFORE
      // push — the commit already landed locally (cheap to recover: amend /
      // reset / redo), and per the spec's "placement: push time, not commit
      // time" design decision, gating here is what makes push-time placement
      // concrete for `sessionCommit`, which commits and pushes atomically in
      // one call (nothing below this point reaches `git push` unless this
      // gate passes). See `computeCommitDeletionStats`'s doc comment for why
      // the diff is against the first parent specifically.
      const deletionStats = await computeCommitDeletionStats(gitService, workdir);
      if (deletionStats && deletionStats.deletionCount > DEFAULT_MASS_DELETION_THRESHOLD) {
        const override = resolveDestructiveOverride(params.overrideReason);
        if (!isValidDestructiveOverride(override)) {
          throw new MassDeletionGuardError(
            `session_commit: staged delta deletes ${deletionStats.deletionCount} tracked file(s), ` +
              `exceeding the mass-deletion sanity threshold (${DEFAULT_MASS_DELETION_THRESHOLD}). ` +
              `The commit has landed LOCALLY but was NOT pushed. Sample of deleted paths: ` +
              `${deletionStats.sampleDeletedPaths.slice(0, 10).join(", ")}` +
              `${deletionStats.sampleDeletedPaths.length > 10 ? ", ..." : ""}. ` +
              `If this deletion is intentional, retry with overrideReason set to a ` +
              `justification (or set MINSKY_ACK_DESTRUCTIVE).`,
            deletionStats.deletionCount,
            DEFAULT_MASS_DELETION_THRESHOLD,
            deletionStats.sampleDeletedPaths
          );
        }
        await recordDestructiveOverride({
          guard: "session-commit-mass-deletion",
          reason: override.reason,
          details: {
            deletionCount: deletionStats.deletionCount,
            threshold: DEFAULT_MASS_DELETION_THRESHOLD,
            sampleDeletedPaths: deletionStats.sampleDeletedPaths,
            commitHash: commitResult.commitHash,
          },
          persistenceProvider,
          relatedSessionId: params.session,
          relatedTaskId: sessionRecordForFreeze?.taskId,
        });
      }

      const metadata = await collectCommitMetadata(gitService, workdir);

      // Update session activity state after a successful LOCAL commit —
      // independent of push outcome (mt#3049): the local git state changed
      // regardless of whether the push below succeeds.
      try {
        const { SessionStatus } = await import("./types");
        const currentSession = await sessionProvider.getSession(params.session);
        const newCommitCount = (currentSession?.commitCount ?? 0) + 1;
        await sessionProvider.updateSession(params.session, {
          lastActivityAt: new Date().toISOString(),
          lastCommitHash: commitResult.commitHash,
          lastCommitMessage: params.message,
          commitCount: newCommitCount,
          status:
            currentSession?.status === SessionStatus.CREATED
              ? SessionStatus.ACTIVE
              : currentSession?.status,
        });
      } catch (e) {
        log.debug("Failed to update session activity state", { error: e });
      }

      // mt#3660: a CONFLICTED `session_update` parks the operator's uncommitted
      // work in a stash and cannot restore it — a pop during an active merge is
      // refused, because `git stash pop` requires the working directory to match
      // the index. The merge commit has just landed, so MERGE_HEAD is gone and the
      // tree is clean: this is the first moment the pop is legal, and the last one
      // before the push below would publish a commit that silently lacks the work.
      //
      // Restoring here deliberately leaves the recovered work UNCOMMITTED. It
      // belongs in its own commit, not folded into a merge resolution — and the
      // report below says so, because a caller that assumed otherwise is how this
      // failed four times.
      //
      // A failed pop is non-destructive by git's own guarantee ("Applying the state
      // can fail with conflicts; in this case, it is not removed from the stash
      // list"), so the worst case is work still parked WITH a named report.
      let stashRestore: StashRestoreOutcome | undefined;
      try {
        stashRestore = await restoreUpdateStashAfterCommit(workdir, gitService);
        if (stashRestore && !stashRestore.restored) {
          const parked = (stashRestore.parkedFiles ?? []).map((f) => `\n     - ${f}`).join("");
          // mt#4307: say whether the pop CONFLICTED, and what became of the
          // markers. The push below runs the pre-push gated suite against this
          // very working tree, so "markers are present" is the single most
          // load-bearing fact the operator can be told at this moment — it is
          // the difference between "my change broke twenty tests" and "the pop
          // corrupted a file my change never touched".
          const conflicted = stashRestore.conflictedFiles ?? [];
          const conflictNotice =
            conflicted.length > 0
              ? `\n   The pop CONFLICTED on: ${conflicted.join(", ")}.\n   ${
                  stashRestore.rolledBack
                    ? `It was ROLLED BACK — the working tree is clean and carries no conflict markers.`
                    : `It could NOT be rolled back — conflict markers ARE in the working tree; any ` +
                      `check that runs next will fail on them, not on this commit.`
                }`
              : "";
          log.cli(
            `⚠️  Work stashed by an earlier session_update was NOT restored and remains ` +
              `parked in ${stashRestore.stashRef}. This commit does NOT contain it.${parked}` +
              `${conflictNotice}\n` +
              `   ${stashRestore.recovery ?? ""}`
          );
        } else if (stashRestore?.restored) {
          // One line, not three (PR #3076 R1). This is NOT the ordinary success
          // path — `stashRestore` is undefined unless an update-parked stash was
          // actually found, so an ordinary commit prints nothing here. When it
          // does fire, the operator has uncommitted work they did not put back
          // themselves, and saying so is the entire point of the task.
          log.cli(
            `   (Restored work parked by an earlier session_update from ${stashRestore.stashRef} — ` +
              `now uncommitted in the working tree, NOT in this commit.)`
          );
        }
      } catch (restoreError) {
        // Never fail a landed commit over the stash check, but never hide it either.
        log.warn("Failed to restore update-parked stash after commit", {
          session: params.session,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }

      // mt#4307 SC2: a failed pop is the PRIMARY outcome of this call, not a
      // secondary field beside a downstream error. The originating incident is
      // exactly this ordering: `pushError` carried twenty cockpit-test failures
      // while the cause sat in `stashRestore.error` on the same payload, and the
      // natural reading of the result was "my change broke twenty tests".
      //
      // The commit itself still succeeded, so `success` stays true and the hash
      // is still returned — what changes is which fact the message LEADS with.
      const reportedMessage =
        stashRestore && !stashRestore.restored
          ? `${`Committed ${commitResult.commitHash ?? ""}`.trim()} — but restoring work parked by an earlier session_update FAILED${
              (stashRestore.conflictedFiles ?? []).length > 0
                ? ` (the pop conflicted on ${(stashRestore.conflictedFiles ?? []).join(", ")}` +
                  `${stashRestore.rolledBack ? " and was rolled back" : " and could NOT be rolled back"})`
                : ` (${stashRestore.error ?? "unknown error"})`
            }. That work is still parked in ${stashRestore.stashRef} and is NOT in this commit.`
          : commitResult.message;

      // Always push changes in session context - commit and push should be atomic
      // mt#1477: when a token provider is available, use the App installation
      // token for push authentication so pull_request workflows trigger.
      // mt#2897: credential resolution is loud + surfaced — the silent
      // fallback here was the leading root-cause hypothesis for the
      // intermittent "push delivered but zero workflow runs" class.
      // mt#3210: pushSessionCommitWithFallback wraps resolution + push +
      // an automatic keychain retry when the App-token push itself is
      // denied (403) — the case resolution-loudness alone (mt#2897) did
      // not cover, since token minting succeeds and only the push fails.

      // mt#3049: bounded AND non-throwing on failure/timeout. A push problem
      // after a successful commit now returns a STRUCTURED partial outcome
      // (commitHash set, pushed:false, pushError/pushTimedOut named) instead
      // of propagating a raw exception that discards the fact the commit
      // already landed locally — the core fix for the originating mt#3003
      // incident (session_commit hung ~30 minutes with no result, then the
      // commit turned out to have landed but never pushed).
      //
      // mt#3177: on a `pushTimedOut` outcome, `pushWithConfirmation` (called
      // via `pushFromParamsWithConfirmation` below) additionally verifies the
      // remote ref directly (`git ls-remote`) before reporting anything — the
      // 2nd occurrence of this task's originating incident established that
      // the underlying push had ALREADY LANDED server-side while the tool's
      // own confirmation was still hanging. When the remote check confirms
      // the push landed, this reports `pushed:true` +
      // `pushConfirmedVia:"remote-check"` instead of the previous ambiguous
      // `pushed:false, pushTimedOut:true` shape; when it cannot confirm
      // either way, it reports the new explicit `pushUnconfirmed:true` state
      // that no consumer can mistake for success. Same non-cancellation
      // caveat as the commit phase (review R1, see
      // SessionCommitPhaseTimeoutError's doc comment for the full
      // explanation): on a still-inconclusive outcome, the underlying `git
      // push` is NOT killed — it may still complete in the background after
      // this function returns. A caller that retries immediately (including
      // this file's own `tryResumePendingPush` on a later call) could in
      // principle race a still-running abandoned push; the CAS check above
      // and git's own atomicity around ref updates bound the damage (worst
      // case: a harmless redundant push of the same content), but this is
      // not a fully closed race. True cancellation would need `Bun.spawn` +
      // an `AbortSignal` threaded through the push call.
      const pushTimeoutMs = params.pushTimeoutMs ?? DEFAULT_PUSH_PHASE_TIMEOUT_MS;
      const pushOutcome = await pushSessionCommitWithFallback(
        tokenProvider,
        { repo: workdir, branch: metadata.branch },
        { pushTimeoutMs, session: params.session },
        { pushFromParamsWithConfirmation }
      );
      const pushCredential = { credentialPath: pushOutcome.credentialPath };
      const pushed = pushOutcome.pushed;

      if (!pushed) {
        log.warn(
          "[session.commit] commit succeeded but push did not — returning structured partial outcome (mt#3049/mt#3177)",
          {
            session: params.session,
            commitHash: commitResult.commitHash,
            pushTimedOut: pushOutcome.pushTimedOut,
            pushError: pushOutcome.pushError,
            pushUnconfirmed: pushOutcome.pushUnconfirmed,
          }
        );
        return {
          success: true,
          commitHash: commitResult.commitHash,
          ...metadata,
          message: reportedMessage,
          pushed: false,
          ...(stashRestore ? { stashRestore } : {}),
          ...(pushOutcome.pushError !== undefined ? { pushError: pushOutcome.pushError } : {}),
          ...(pushOutcome.pushTimedOut ? { pushTimedOut: true } : {}),
          ...(pushOutcome.pushUnconfirmed ? { pushUnconfirmed: true } : {}),
          ...(pushOutcome.appTokenPushError !== undefined
            ? { appTokenPushError: pushOutcome.appTokenPushError }
            : {}),
          credentialPath: pushCredential.credentialPath,
        };
      }

      if (pushOutcome.pushConfirmedVia) {
        log.debug(
          "[session.commit] push timed out but remote-ref check confirmed it landed (mt#3177)",
          {
            session: params.session,
            commitHash: commitResult.commitHash,
            pushConfirmedVia: pushOutcome.pushConfirmedVia,
          }
        );
      }

      return {
        success: true,
        commitHash: commitResult.commitHash,
        ...metadata,
        message: reportedMessage,
        pushed: true,
        ...(stashRestore ? { stashRestore } : {}),
        ...(pushOutcome.pushTimedOut ? { pushTimedOut: true } : {}),
        ...(pushOutcome.pushConfirmedVia ? { pushConfirmedVia: pushOutcome.pushConfirmedVia } : {}),
        ...(pushOutcome.appTokenPushError !== undefined
          ? { appTokenPushError: pushOutcome.appTokenPushError }
          : {}),
        credentialPath: pushCredential.credentialPath,
      };
    } catch (error) {
      log.debug("Session commit failed", {
        error: error instanceof Error ? error.message : String(error),
        session: params.session,
      });
      throw error;
    }
  } finally {
    // mt#1522 / PR #963 R1 BLOCKING #5: cleanup runs on every exit path
    // (early returns, throws, success). Marker is transient state that
    // should not persist past one sessionCommit attempt; the next hook
    // run will write a fresh marker if needed.
    cleanupFreshnessMarker(workdir);
  }
}

/**
 * Collect commit metadata (branch, author/subject/timestamp/short-hash,
 * diffstat, changed-files list) for the CURRENT HEAD commit. Extracted
 * (mt#3049) from `sessionCommit`'s inline success-path block so it can be
 * reused by the success path, the push-failure/timeout partial-outcome path,
 * and the resumable-push path (`tryResumePendingPush`) below — the commit
 * itself has already landed locally in all three cases, so all three deserve
 * the same metadata. Every field is independently best-effort (mirrors the
 * original inline behavior): a failure to read ANY one field degrades that
 * field to `undefined` rather than failing the whole call.
 */
async function collectCommitMetadata(
  gitService: Pick<GitServiceInterface, "getCurrentBranch" | "execInRepository">,
  workdir: string
): Promise<{
  branch?: string;
  shortHash?: string;
  subject?: string;
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  files?: Array<{ path: string; status: string }>;
}> {
  // Branch name
  let branch: string | undefined;
  try {
    branch = await gitService.getCurrentBranch(workdir);
  } catch (err) {
    log.debug("Failed to get branch name", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Author, subject, timestamp, short hash
  let shortHash: string | undefined;
  let subject: string | undefined;
  let authorName: string | undefined;
  let authorEmail: string | undefined;
  let timestamp: string | undefined;
  try {
    // mt#3049: the format string MUST be quoted. `execInRepository` shells
    // out via `/bin/sh -c` (Node's `child_process.exec` under
    // `@minsky/shared/exec`'s `execAsync`), so an UNQUOTED `|` in the
    // command string is interpreted as an actual shell pipe, not passed
    // through to git — verified empirically: the unquoted form always threw
    // ("%s: command not found", etc.), meaning this whole try block has been
    // silently failing on EVERY session_commit call (caught below, logged at
    // debug level, degrading shortHash/subject/authorName/authorEmail/
    // timestamp to undefined) since it shipped. No prior test asserted these
    // fields were populated, so the failure was invisible.
    //
    // Delimiter is `%x00` (a literal NUL byte git emits for this format
    // placeholder), NOT `|` (review R1, mt#3049 PR #2183): a commit SUBJECT
    // can legitimately contain a `|` character, which would silently shift
    // every field after it when splitting on `|` — a real, if rarer,
    // corruption distinct from the shell-quoting bug above. NUL cannot
    // appear in a git pretty-format field's rendered text (author name/
    // email/subject/timestamp are all plain text), so splitting on it is
    // unambiguous. Single-quoting the whole format string is still required
    // and still safe (the format string is a static literal, not
    // user-controlled input).
    const pretty = await gitService.execInRepository(
      workdir,
      "git log -1 --pretty=format:'%h%x00%s%x00%an%x00%ae%x00%aI'"
    );
    const parts = pretty.trim().split("\u0000");
    if (parts.length >= 5) {
      shortHash = parts[0];
      subject = parts[1];
      authorName = parts[2];
      authorEmail = parts[3];
      timestamp = parts[4];
    }
  } catch (err) {
    log.debug("Failed to read commit metadata", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Diffstat summary
  let filesChanged: number | undefined;
  let insertions: number | undefined;
  let deletions: number | undefined;
  try {
    const shortstat = await gitService.execInRepository(
      workdir,
      "git show -1 --shortstat --pretty=format:"
    );
    const line = shortstat
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (line) {
      const match =
        /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/.exec(
          line
        );
      if (match) {
        filesChanged = parseInt(match[1] || "0", 10);
        insertions = parseInt(match[2] || "0", 10);
        deletions = parseInt(match[3] || "0", 10);
      }
    }
  } catch (err) {
    log.debug("Failed to parse diffstat", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Changed files list with status
  let files: Array<{ path: string; status: string }> | undefined;
  try {
    const nameStatus = await gitService.execInRepository(
      workdir,
      "git show -1 -M -C --name-status --pretty=format:"
    );
    const lines = nameStatus
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    files = lines.map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      let path = parts[1] || "";
      if (status.startsWith("R") || status.startsWith("C")) {
        path = parts[2] || parts[1] || "";
      }
      return { status, path };
    });
  } catch (err) {
    log.debug("Failed to list changed files", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    branch,
    shortHash,
    subject,
    authorName,
    authorEmail,
    timestamp,
    filesChanged,
    insertions,
    deletions,
    files,
  };
}

/**
 * mt#3049 resumable-push path: on an otherwise-clean tree, check whether the
 * LOCAL branch already carries a commit that never reached `origin` — the
 * "committed but push omitted" gap this task closes (a prior `sessionCommit`
 * call's push phase may have failed or timed out AFTER its commit landed).
 * When such a gap exists, complete the pending push and report the ACTUAL
 * existing HEAD commit + push outcome, instead of the historical
 * unconditional "nothing to commit" no-op that never even looked at the
 * remote.
 *
 * Fails OPEN (returns `undefined`, meaning "fall back to the legacy no-op")
 * on any ambiguity: no `origin` remote configured, a failed fetch, an
 * undeterminable branch/HEAD, or HEAD already matching `origin/<branch>`
 * (genuinely nothing pending). This must never turn a routine "nothing to
 * commit" call into an unexpected push attempt when there is nothing to
 * resume — the existing `session-commit-no-files.test.ts` "noFiles=false on
 * clean tree" test (a repo with NO remote at all) pins this fallback.
 */
async function tryResumePendingPush(
  workdir: string,
  deps: {
    session: string;
    tokenProvider?: TokenProvider;
    pushTimeoutMs: number;
  }
): Promise<SessionCommitResult | undefined> {
  const { createGitService, pushFromParamsWithConfirmation } = await import("../git");
  const gitService = createGitService();

  let branch: string;
  try {
    branch = await gitService.getCurrentBranch(workdir);
  } catch {
    return undefined;
  }
  if (!branch) return undefined;

  try {
    const remotesOut = await gitService.execInRepository(workdir, "git remote");
    const remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!remotes.includes("origin")) {
      // No remote configured at all — the legacy "nothing to commit" no-op
      // is correct as-is (nothing CAN be pushed).
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    await gitService.execInRepository(workdir, "git fetch origin --prune --no-tags --quiet");
  } catch {
    // Fetch failure is ambiguous (network, auth, transient) — fail open
    // rather than risk a false "nothing pending" verdict or an unwanted push
    // attempt against a stale view of origin.
    return undefined;
  }

  let headSha: string;
  try {
    headSha = (await gitService.execInRepository(workdir, "git rev-parse HEAD")).trim();
  } catch {
    return undefined;
  }

  let remoteSha: string | null = null;
  try {
    // `--verify --end-of-options`, NOT a trailing `--` — see the identical
    // fix + full explanation on the CAS check's `resolveRefSha` above in
    // this file: `git rev-parse -- <ref>` treats `--`-terminated arguments
    // as pathspecs and never actually resolves the ref to a SHA.
    remoteSha = (
      await gitService.execInRepository(
        workdir,
        `git rev-parse --verify --end-of-options ${safeShellQuote(`origin/${branch}`)}`
      )
    ).trim();
  } catch {
    // origin/<branch> doesn't exist yet — the branch was never pushed at
    // all, which is itself a pending-push condition, not an error.
    remoteSha = null;
  }

  if (remoteSha === headSha) {
    // Local and remote already agree — genuinely nothing to resume.
    return undefined;
  }

  log.debug("[session.commit] resumable-push: local HEAD is ahead of origin on a clean tree", {
    session: deps.session,
    branch,
    headSha,
    remoteSha,
  });

  // mt#3210: same automatic-fallback wrapper as the main sessionCommit push
  // path — retries via system keychain credentials when the App-token push
  // is denied (403), instead of surfacing a failed push the caller must
  // notice and retry by hand.
  const pushOutcome = await pushSessionCommitWithFallback(
    deps.tokenProvider,
    { repo: workdir, branch },
    { pushTimeoutMs: deps.pushTimeoutMs, session: deps.session },
    { pushFromParamsWithConfirmation }
  );
  const pushCredential = { credentialPath: pushOutcome.credentialPath };
  const pushed = pushOutcome.pushed;

  const metadata = await collectCommitMetadata(gitService, workdir);

  return {
    success: true,
    nothingToCommit: true,
    resumedPush: true,
    // mt#3049: `commitHash` matches the SHORT-hash convention every other
    // sessionCommit return path uses (`commitResult.commitHash`, parsed from
    // `git commit`'s own stdout banner, is short — see extractCommitHash in
    // git-with-deps.ts). `metadata.shortHash` (from `git log -1 --format=%h`)
    // is the same short form for this pre-existing HEAD commit; `headSha`
    // (full 40-char, used above for the actual origin-vs-HEAD comparison,
    // which wants the unambiguous full form) is the fallback only if
    // metadata collection somehow failed to read it.
    commitHash: metadata.shortHash ?? headSha,
    ...metadata,
    message: pushed
      ? "Nothing new to commit; completed a previously pending push"
      : "Nothing new to commit; a previously pending push is still outstanding",
    pushed,
    ...(pushOutcome.pushError !== undefined ? { pushError: pushOutcome.pushError } : {}),
    ...(pushOutcome.pushTimedOut ? { pushTimedOut: true } : {}),
    ...(pushOutcome.pushConfirmedVia ? { pushConfirmedVia: pushOutcome.pushConfirmedVia } : {}),
    ...(pushOutcome.pushUnconfirmed ? { pushUnconfirmed: true } : {}),
    ...(pushOutcome.appTokenPushError !== undefined
      ? { appTokenPushError: pushOutcome.appTokenPushError }
      : {}),
    credentialPath: pushCredential.credentialPath,
  };
}
