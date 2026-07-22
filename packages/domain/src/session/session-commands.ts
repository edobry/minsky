/**
 * Session Commands
 *
 * Session operations that accept session parameters.
 */

import { MinskyError, NothingToCommitError } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { safeShellQuote } from "@minsky/shared/exec";
import type { AskRepository } from "../ask/repository";
import { closeAskAsResolved } from "../ask/close-as-resolved";
import { isActionCovered, loadAllPolicySources } from "../ask/policy";
import { emitSystemEventFromProvider } from "../events/emit-best-effort";
import type { PersistenceProvider } from "../persistence/types";
import type { TokenProvider } from "../auth/token-provider";
import type { GitServiceInterface } from "../git/types";
import { checkFreshnessCas, cleanupFreshnessMarker } from "./freshness-marker";

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
 * Default wall-clock bound for the PUSH phase (`git push` — no hooks fire on
 * this side, so cost is dominated by network round-trip) — mt#3049. 2
 * minutes is generous for a push (typically seconds) while still bounding
 * the caller's wait well below the 30-minute incident duration; a push that
 * genuinely needs longer than 2 minutes on a healthy network is itself
 * diagnostic-worthy.
 */
export const DEFAULT_PUSH_PHASE_TIMEOUT_MS = 2 * 60 * 1000;

/** Real `setTimeout`-backed timeout signal — the non-test default for `raceAgainstTimeout`. */
function defaultTimeoutSignal(ms: number): Promise<{ timedOut: true }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), ms);
  });
}

/**
 * Generic bounded race between a real async operation and a timeout signal
 * (mt#3049). Returns a discriminated result so callers never need to infer
 * "timed out" from an operation's own return shape.
 *
 * `timeoutSignal` is injectable (mirrors the `sleep`-injection pattern
 * already established by `LockAwareExecOptions` in `git/lock-operations.ts`,
 * mt#2886/mt#2980) so tests can simulate an instantly-elapsed timeout without
 * any real wall-clock wait — pair an injected `timeoutSignal` that resolves
 * immediately with an `operation` that never resolves on its own (e.g.
 * `new Promise(() => {})`) to deterministically exercise the "timeout wins"
 * branch in well under a millisecond.
 */
export function raceAgainstTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutSignal: (ms: number) => Promise<{ timedOut: true }> = defaultTimeoutSignal
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return Promise.race([
    operation.then((value) => ({ timedOut: false as const, value })),
    timeoutSignal(timeoutMs),
  ]);
}

/**
 * Which credential path a session-commit push used (mt#2897).
 *
 * - "app-token": GitHub App installation token resolved and used — the path
 *   that reliably triggers pull_request workflows (mt#1477).
 * - "keychain-unconfigured": no service account is configured; system
 *   credentials are the expected path for this install (not a failure).
 * - "keychain-fallback": a service account IS configured but token resolution
 *   failed — the push falls back to system keychain credentials, which may
 *   silently fail to trigger pull_request workflows (the intermittent CI-miss
 *   class in docs/ci-check-never-ran-playbook.md §Root cause).
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
 * Session PR creation parameters
 */
export interface SessionPrParams {
  session: string;
  title?: string;
  body?: string;
  bodyPath?: string;
  noStatusUpdate?: boolean;

  skipConflictCheck?: boolean;
  autoResolveDeleteConflicts?: boolean;
  debug?: boolean;
}

// ❌ DELETED: sessionPr() wrapper function - redundant duplicate
// This function was a wrapper around sessionPrFromParams (legacy implementation).
// All callers should use the modern sessionPr() from ./commands/pr-command.ts instead.

/**
 * Session update interface with explicit parameters
 */
export interface SessionUpdateParams {
  session: string; // ✅ ALWAYS required
  branch?: string;
  force?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
  noPush?: boolean;
  skipConflictCheck?: boolean;
  skipIfAlreadyMerged?: boolean;
  autoResolveDeleteConflicts?: boolean;
}

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

  const { commitChangesFromParams, pushFromParams, createGitService } = await import("../git");

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
          // marker.mainRef captured here would require re-reading the marker;
          // skip in favor of the reason field which already names the ref.
          ""
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

      // Always push changes in session context - commit and push should be atomic
      // mt#1477: when a token provider is available, use the App installation
      // token for push authentication so pull_request workflows trigger.
      // mt#2897: credential resolution is loud + surfaced — the silent
      // fallback here was the leading root-cause hypothesis for the
      // intermittent "push delivered but zero workflow runs" class.
      const pushCredential = await resolvePushCredential(tokenProvider, {
        session: params.session,
      });

      // mt#3049: bounded AND non-throwing on failure/timeout. A push problem
      // after a successful commit now returns a STRUCTURED partial outcome
      // (commitHash set, pushed:false, pushError/pushTimedOut named) instead
      // of propagating a raw exception that discards the fact the commit
      // already landed locally — the core fix for the originating mt#3003
      // incident (session_commit hung ~30 minutes with no result, then the
      // commit turned out to have landed but never pushed).
      const pushTimeoutMs = params.pushTimeoutMs ?? DEFAULT_PUSH_PHASE_TIMEOUT_MS;
      let pushed = false;
      let pushTimedOut = false;
      let pushError: string | undefined;
      try {
        const raced = await raceAgainstTimeout(
          pushFromParams({ repo: workdir, authToken: pushCredential.authToken }),
          pushTimeoutMs
        );
        if (raced.timedOut) {
          pushTimedOut = true;
        } else {
          pushed = raced.value.pushed;
        }
      } catch (err: unknown) {
        pushError = err instanceof Error ? err.message : String(err);
      }

      if (!pushed) {
        log.warn(
          "[session.commit] commit succeeded but push did not — returning structured partial outcome (mt#3049)",
          {
            session: params.session,
            commitHash: commitResult.commitHash,
            pushTimedOut,
            pushError,
          }
        );
        return {
          success: true,
          commitHash: commitResult.commitHash,
          ...metadata,
          message: commitResult.message,
          pushed: false,
          ...(pushError !== undefined ? { pushError } : {}),
          ...(pushTimedOut ? { pushTimedOut: true } : {}),
          credentialPath: pushCredential.credentialPath,
        };
      }

      return {
        success: true,
        commitHash: commitResult.commitHash,
        ...metadata,
        message: commitResult.message,
        pushed: true,
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
    // fields were populated, so the failure was invisible. Single-quoting is
    // safe here because the format string is a static literal, not
    // user-controlled input.
    const pretty = await gitService.execInRepository(
      workdir,
      "git log -1 --pretty=format:'%h|%s|%an|%ae|%aI'"
    );
    const parts = pretty.trim().split("|");
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
  const { createGitService, pushFromParams } = await import("../git");
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

  const pushCredential = await resolvePushCredential(deps.tokenProvider, {
    session: deps.session,
  });

  let pushed = false;
  let pushTimedOut = false;
  let pushError: string | undefined;
  try {
    const raced = await raceAgainstTimeout(
      pushFromParams({ repo: workdir, authToken: pushCredential.authToken }),
      deps.pushTimeoutMs
    );
    if (raced.timedOut) {
      pushTimedOut = true;
    } else {
      pushed = raced.value.pushed;
    }
  } catch (err: unknown) {
    pushError = err instanceof Error ? err.message : String(err);
  }

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
    ...(pushError !== undefined ? { pushError } : {}),
    ...(pushTimedOut ? { pushTimedOut: true } : {}),
    credentialPath: pushCredential.credentialPath,
  };
}
