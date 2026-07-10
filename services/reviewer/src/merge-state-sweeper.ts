/**
 * Periodic sweeper for post-merge state sync.
 *
 * Safety-net backstop for the primary webhook path (pull_request.closed
 * && merged=true handler in server.ts). Lists Minsky-tracked sessions in
 * PR_OPEN state, identifies any whose linked GitHub PR is actually
 * closed-merged, and calls applyPostMergeStateSync via domain imports.
 *
 * ## Why a separate sweeper (not folded into sweeper.ts)
 *
 * sweeper.ts targets open PRs missing a review — it only lists open PRs.
 * This sweeper targets closed-merged PRs with un-synced Minsky state — it
 * needs to list PR_OPEN sessions and check GitHub PR state, not list open
 * GitHub PRs. The data flows are orthogonal, so a separate module avoids
 * coupling.
 *
 * ## Cadence choice
 *
 * Default: 10 minutes (600_000 ms), same as the missed-review sweeper
 * (mt#1260). Calibration basis: bypass-merge events occur on the order
 * of 1/day in the Minsky project; a 10-min window means any stranded
 * session is caught within 10 min of the webhook firing. The sweeper
 * is the backstop — the webhook path is the primary mechanism. A 10-min
 * cadence keeps Railway CPU load negligible even on repos with many
 * sessions. Configurable via MERGE_STATE_SWEEPER_INTERVAL_MS.
 *
 * Per feedback_threshold_grounding: Minsky's loop cadence is ~1/day for
 * bypass-merge invocations. A 10-min sweeper window is overkill for the
 * steady-state case, but appropriate as a backstop since it means any
 * webhook-missed merge is caught within one polling window. A 24h window
 * would exceed Minsky's 5-day budget window and miss real-time guarantees.
 *
 * ## Covers / Does NOT cover
 *
 * ### Covers
 * - PR merged via `gh api PUT /merge` (bypass-merge) where the webhook fired
 *   but the handler had a transient error.
 * - PR merged via GitHub UI where the webhook fired but delivery failed.
 * - PR merged while the reviewer service was restarting (webhook missed entirely).
 *
 * ### Does NOT cover
 * - Sessions stuck in PR_OPEN where the PR number was never recorded in Minsky
 *   (session.pullRequest is null). Owner: mt#1614 repair-pass script handles
 *   the historical case; future sessions will have the PR number via pr-create.
 * - Minsky DB itself being unreachable (sweeper can't list sessions).
 *   Owner: infrastructure monitoring (mt#1310).
 * - GitHub API being unreachable (sweeper can't check PR state).
 *   Owner: infrastructure monitoring.
 *
 * ## Detection source (mt#1752)
 *
 * The sweeper queries **live GitHub PR state via Octokit** (`pulls.get`), NOT
 * the stored `session.pullRequest.state` field. The stored state is only
 * refreshed by the post-merge sync path; if that path itself fails (the
 * problem the sweeper exists to recover from), the stored state stays at
 * `"open"` indefinitely and the sweeper would be blind to merges. Querying
 * GitHub directly is the only reliable detection.
 *
 * Origin: mt#1752 — six historical drift incidents went undetected for
 * 5–43 hours each despite the sweeper running every 10 min, because the
 * predicate trusted stored state.
 *
 * ## Boot catch-up sweep (mt#2684)
 *
 * Same structural gap as sweeper.ts's boot catch-up fix (mt#2660): `setInterval`
 * fires its first tick only after a full `intervalMs` elapses — NOT immediately
 * at boot. The reviewer service auto-redeploys on every merge to main that
 * touches its own source (mt#2345/mt#2352 scoped `watchPatterns` to the
 * reviewer's own paths, not off entirely), so the process restarts frequently.
 * Each restart resets the `setInterval` clock, so a merge whose post-merge
 * webhook delivery the outgoing process missed (bypass-merge, GitHub-UI merge
 * during a restart, etc.) is not caught by the periodic sweep until a FULL
 * `intervalMs` (10 min default) elapses with NO further redeploy in
 * between — unbounded under a burst of closely-spaced merges, exactly
 * mirroring mt#2660's diagnosis for the missed-review sweeper.
 *
 * This gap was identified during mt#2660's convergence but was explicitly out
 * of that task's scope — its spec's `### Does NOT cover` recorded "no owner
 * task filed yet" for this file. mt#2684 is that owner.
 *
 * ### Invocation path
 *
 * Wired into `startMergeStateSweeper` (this file): when
 * `sweeperConfig.enabled=true` (gate 1) AND `sweeperConfig.bootCatchupEnabled`
 * resolves true (gate 2; env var `MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED`,
 * default `"true"` — explicit opt-out via
 * `MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED=false`), `startMergeStateSweeper`
 * invokes one sweep cycle synchronously at call time (fired from
 * `services/reviewer/src/server.ts`'s boot sequence, at the same call site as
 * the sibling `startSweeper` — AFTER migrations + domain-container boot have
 * already completed), before the `setInterval` handle is created. The
 * immediate cycle and the periodic ticks share the same `runCycle` closure
 * (same reentrancy guard `isRunning`, same cached-Octokit promise), so the
 * boot catch-up cannot race a periodic tick.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { createOctokit } from "./github-client";
import { githubAuthHealth } from "./auth-health";
import { withTimeout, TimeoutError } from "./with-timeout";
import type { Octokit } from "@octokit/rest";
import { log } from "./logger";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session";
import type { TaskServiceInterface } from "@minsky/domain/tasks";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface MergeStateSweeperConfig {
  /** Sweep interval in milliseconds. Default: 600_000 (10 min). */
  intervalMs: number;
  /**
   * Whether the sweeper is enabled. Default: true (flipped from false on mt#1811).
   *
   * The sweeper is mt#1614's load-bearing recovery mechanism for bypass-merge state-sync
   * drift. Defaulting to disabled silently strands sessions whose webhook delivery missed.
   * Operators can still explicitly opt out via MERGE_STATE_SWEEPER_ENABLED=false.
   */
  enabled: boolean;
  /**
   * Owner of the target GitHub repo. Reads `SWEEPER_REPO_OWNER` for parity with the
   * sibling `sweeper.ts` (missed-review sweeper); defaults to `"edobry"` since both
   * sweepers operate on the same repo in production. mt#1752.
   */
  owner: string;
  /**
   * Name of the target GitHub repo. Reads `SWEEPER_REPO_NAME` for parity with the
   * sibling `sweeper.ts`; defaults to `"minsky"`. mt#1752.
   */
  repo: string;
  /**
   * True when `owner` was not explicitly set in the env and the default was used.
   * Surfaced in the `merge_state_sweeper.started` log so operators can audit silent
   * mis-targeting risk in non-Minsky deployments. PR #1116 R1 BLOCKING.
   */
  ownerDefaulted: boolean;
  /**
   * True when `repo` was not explicitly set in the env and the default was used.
   * Surfaced in the `merge_state_sweeper.started` log. PR #1116 R1 BLOCKING.
   */
  repoDefaulted: boolean;
  /**
   * Per-call timeout for `octokit.rest.pulls.get` in milliseconds. A hung GitHub
   * request would otherwise block the entire `Promise.all` chunk and leave
   * `isRunning=true`, causing subsequent cycles to be skipped as `skip_reentrant`
   * — effectively disabling the backstop until the request resolves. PR #1116 R1
   * BLOCKING. Reads `MERGE_STATE_SWEEPER_GITHUB_TIMEOUT_MS`; defaults to 30s
   * (same baseline as `REVIEWER_GITHUB_TIMEOUT_MS` in `github-client.ts`).
   */
  githubTimeoutMs: number;
  /**
   * Whether `startMergeStateSweeper` runs one sweep cycle immediately at
   * boot, in addition to the periodic `setInterval` ticks (mt#2684 — see
   * module-header "Boot catch-up sweep"; mirrors sweeper.ts's mt#2660 fix).
   * Default true; explicit opt-out via
   * `MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED=false` for operators who want
   * to avoid the extra GitHub API + domain-service calls on every boot.
   */
  bootCatchupEnabled: boolean;
}

export function loadMergeStateSweeperConfig(): MergeStateSweeperConfig {
  const ownerEnv = process.env["SWEEPER_REPO_OWNER"];
  const repoEnv = process.env["SWEEPER_REPO_NAME"];
  return {
    // 10-minute default: see cadence rationale in module docstring.
    // Strict-positive parse (mt#1811 R1 BLOCKING fix): now that the sweeper
    // defaults to enabled, a misconfigured interval would feed NaN to
    // setInterval and produce a tight CPU loop. parsePositiveIntEnv throws
    // at boot time on any non-positive-integer value, making misconfiguration
    // a clear startup error instead.
    intervalMs: parsePositiveIntEnv("MERGE_STATE_SWEEPER_INTERVAL_MS", 600_000),
    // Default to enabled (mt#1811). Domain services are injected at start time;
    // if they're absent, startMergeStateSweeper refuses to start with a clear log.
    enabled: (process.env["MERGE_STATE_SWEEPER_ENABLED"] ?? "true") === "true",
    // Reuse the sibling sweeper's env vars — both sweepers run against the same repo.
    // mt#1752.
    owner: ownerEnv ?? "edobry",
    repo: repoEnv ?? "minsky",
    // PR #1116 R1 BLOCKING: surface when defaults are in effect so silent mis-targeting
    // in non-Minsky deployments produces an operator-visible signal at boot.
    ownerDefaulted: ownerEnv === undefined,
    repoDefaulted: repoEnv === undefined,
    // PR #1116 R1 BLOCKING: bounded timeout for octokit.rest.pulls.get. Strict-positive
    // parse so misconfiguration produces a clear boot-time error rather than NaN/Infinity
    // flowing into the AbortController.
    githubTimeoutMs: parsePositiveIntEnv("MERGE_STATE_SWEEPER_GITHUB_TIMEOUT_MS", 30_000),
    // mt#2684: see module-header "Boot catch-up sweep". Default on so the
    // redeploy-window webhook-miss class is closed by default here too
    // (mirrors sweeper.ts's mt#2660 default); explicit opt-out available.
    bootCatchupEnabled:
      (process.env["MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED"] ?? "true") === "true",
  };
}

// ---------------------------------------------------------------------------
// Domain-service types
// ---------------------------------------------------------------------------

/** Result of a single sweep pass. */
export interface MergeStateSweepResult {
  /** Timestamp when the sweep started (ISO 8601). */
  startedAt: string;
  /** Number of sessions with PR_OPEN status scanned. */
  sessionsScanned: number;
  /** Number of sessions found with closed-merged PRs (unsynced). */
  missedSyncs: number;
  /** Number of sessions for which applyPostMergeStateSync was invoked. */
  syncsTriggered: number;
  /** Errors encountered (non-fatal — sweep continues after each). */
  errors: string[];
}

/** Domain services required by the merge-state sweeper. */
export interface MergeStateSweeperDeps {
  sessionProvider: SessionProviderInterface;
  taskService: TaskServiceInterface;
  /**
   * Test seam for applyPostMergeStateSync. When provided, replaces the real
   * domain-import call. Allows unit tests to verify sync is triggered with the
   * correct arguments without requiring a live DB connection.
   */
  applySyncFn?: (params: {
    sessionId: string;
    mergeSha?: string;
    mergedAt?: string;
    trigger: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Core sweep logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Run a single merge-state sweep cycle using domain services directly.
 *
 * 1. List all sessions, filter to PR_OPEN status in-process.
 * 2. For each PR_OPEN session with a recorded pullRequest.number, call
 *    `octokit.rest.pulls.get` to fetch LIVE GitHub PR state (mt#1752 —
 *    previously used `session.pr.get` which returns stored, never-refreshed
 *    state and made this sweeper structurally blind to merged PRs).
 *    The call is wrapped in `withTimeout` + `AbortSignal` (PR #1116 R1) so a
 *    hung GitHub request cannot deadlock the cycle and block subsequent ticks.
 * 3. If PR is merged on GitHub, call applyPostMergeStateSync domain function directly.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
export async function runMergeStateSweep(
  octokit: Octokit,
  owner: string,
  repo: string,
  deps: MergeStateSweeperDeps,
  githubTimeoutMs: number
): Promise<MergeStateSweepResult> {
  const startedAt = new Date().toISOString();
  const result: MergeStateSweepResult = {
    startedAt,
    sessionsScanned: 0,
    missedSyncs: 0,
    syncsTriggered: 0,
    errors: [],
  };

  log.info("merge_state_sweeper.cycle_start", {
    event: "merge_state_sweeper.cycle_start",
    timestamp: startedAt,
  });

  // Step 1: List all sessions and filter to PR_OPEN status in-process.
  // SessionListOptions has no direct status filter; we filter after fetching.
  let sessions: SessionRecord[] = [];
  try {
    const { SessionStatus } = await import("@minsky/domain/session");
    const allSessions = await deps.sessionProvider.listSessions();
    sessions = allSessions.filter((s) => s.status === SessionStatus.PR_OPEN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to list PR_OPEN sessions: ${msg}`);
    log.error("merge_state_sweeper.list_error", {
      event: "merge_state_sweeper.list_error",
      error: msg,
    });
    return result;
  }

  result.sessionsScanned = sessions.length;
  log.info("merge_state_sweeper.sessions_scanned", {
    event: "merge_state_sweeper.sessions_scanned",
    count: sessions.length,
  });

  // Step 2: For each PR_OPEN session with a pullRequest, check LIVE GitHub state.
  // Cap concurrency at 3 to avoid rate-limiting GitHub.
  const CONCURRENCY = 3;
  const chunks: SessionRecord[][] = [];
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    chunks.push(sessions.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (session) => {
        const sessionId = session.sessionId;

        // Skip sessions without a recorded PR number.
        if (!session.pullRequest?.number) {
          return;
        }

        try {
          // Step 2a: Fetch LIVE GitHub PR state via Octokit (mt#1752).
          //
          // Wrapped in withTimeout + AbortSignal (PR #1116 R1 BLOCKING): a
          // hung GitHub request would otherwise block this Promise.all chunk
          // and leave isRunning=true on the parent interval, causing
          // subsequent ticks to log skip_reentrant — effectively disabling
          // the backstop until the request resolves. The signal is
          // propagated into Octokit via `request: { signal }` so the
          // underlying fetch is cooperatively cancelled.
          const pullNumber = session.pullRequest.number;
          const { data: livePr } = await withTimeout(
            "github.pulls.get",
            githubTimeoutMs,
            (signal) =>
              octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: pullNumber,
                request: { signal },
              })
          );

          // mt#2717: a GitHub call authenticated successfully — reset the
          // shared auth-health failure streak. After the createOctokit refresh
          // fix this is the steady state; a sustained streak now only
          // accumulates on a genuine credential failure (revoked key, etc.).
          githubAuthHealth.recordSuccess();

          if (!livePr.merged) {
            // PR is not merged on GitHub (still open or closed without merge). Skip.
            return;
          }

          // Step 3: PR is merged but session is still PR_OPEN — trigger sync.
          result.missedSyncs++;
          log.warn("merge_state_sweeper.missed_sync_detected", {
            event: "merge_state_sweeper.missed_sync_detected",
            sessionId,
            taskId: session.taskId,
            prNumber: session.pullRequest.number,
            mergedAt: livePr.merged_at,
            mergeSha: livePr.merge_commit_sha,
          });

          // Call applyPostMergeStateSync domain function directly.
          // TOCTOU accept: idempotent — calling twice produces the same final state.
          const syncParams = {
            sessionId,
            mergeSha: livePr.merge_commit_sha ?? undefined,
            mergedAt: livePr.merged_at ?? undefined,
            trigger: "sweeper",
          };
          if (deps.applySyncFn) {
            await deps.applySyncFn(syncParams);
          } else {
            const { applyPostMergeStateSync } = await import(
              "@minsky/domain/session/session-merge-operations"
            );
            await applyPostMergeStateSync(syncParams, {
              sessionDB: deps.sessionProvider,
              taskService: deps.taskService,
            });
          }

          result.syncsTriggered++;
          log.info("merge_state_sweeper.sync_triggered", {
            event: "merge_state_sweeper.sync_triggered",
            sessionId,
            taskId: session.taskId,
            mergedAt: livePr.merged_at,
          });
        } catch (sessionErr) {
          const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
          // Surface timeout errors with a dedicated event so operators can
          // distinguish slow-GitHub from other failures. PR #1116 R1.
          const eventName =
            sessionErr instanceof TimeoutError
              ? "merge_state_sweeper.session_timeout"
              : "merge_state_sweeper.session_error";
          result.errors.push(`Error processing session ${sessionId}: ${msg}`);
          log.warn(eventName, {
            event: eventName,
            sessionId,
            error: msg,
          });
          // mt#2717: feed the shared auth-health tracker. Only auth-class
          // failures (401/403/"Bad credentials") move its counter; a timeout or
          // other error is ignored. When a sustained credential failure crosses
          // the threshold the tracker emits a distinct `reviewer.auth_health_failing`
          // alert instead of leaving this per-session `session_error` spam as the
          // only signal (the 1,730-error state that motivated mt#2717).
          githubAuthHealth.recordFailure("merge_state_sweeper", sessionErr);
        }
      })
    );
  }

  if (result.missedSyncs > 0) {
    log.warn("merge_state_sweeper.primary_webhook_failing", {
      event: "merge_state_sweeper.primary_webhook_failing",
      message: `${result.missedSyncs} session(s) found with closed-merged PRs but unsync'd Minsky state. Webhook delivery may be failing.`,
      missedSyncs: result.missedSyncs,
      syncsTriggered: result.syncsTriggered,
    });
  }

  log.info("merge_state_sweeper.cycle_end", {
    event: "merge_state_sweeper.cycle_end",
    ...result,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the merge-state sweeper on an in-process interval.
 *
 * Same pattern as sweeper.ts (mt#1260) and pr-watch-scheduler.ts (mt#1618).
 * **Enabled by default (mt#1811)**: explicit opt-out via
 * `MERGE_STATE_SWEEPER_ENABLED=false`. Requires domain services to be injected
 * — when absent, logs `missing_domain_services` and returns null.
 *
 * Cadence: 10 min by default (MERGE_STATE_SWEEPER_INTERVAL_MS). See module
 * docstring for calibration rationale.
 *
 * Per mt#1752, the sweep queries live GitHub state via Octokit. The
 * Octokit client is created lazily on the first cycle to keep startup
 * non-blocking, then reused across cycles.
 *
 * mt#2684: a boot catch-up cycle now runs immediately at call time (before
 * the first `setInterval` tick), gated by `sweeperConfig.bootCatchupEnabled`.
 * Prior to mt#2684 the first sweep ran only after one full interval had
 * elapsed, which left an unbounded miss window under closely-spaced
 * redeploys (see module-header "Boot catch-up sweep" for the diagnosis).
 * `startMergeStateSweeper` is called from `server.ts` AFTER migrations have
 * applied and the domain-container boot attempt has resolved, so the
 * immediate cycle does not block or compete with service startup.
 *
 * A reentrancy guard (isRunning) prevents overlapping sweeps if a cycle takes
 * longer than the interval, and also prevents the boot catch-up cycle from
 * racing the first periodic tick.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
export function startMergeStateSweeper(
  config: ReviewerConfig,
  sweeperConfig: MergeStateSweeperConfig,
  deps?: MergeStateSweeperDeps,
  // mt#2684: test seam only — production callers never pass this. When
  // provided, both the boot catch-up cycle and every periodic tick reuse this
  // Octokit instead of calling createOctokit (a real GitHub App auth
  // handshake). Mirrors sweeper.ts's depsOverride test seam (mt#2660).
  octokitOverride?: Octokit
): ReturnType<typeof setInterval> | null {
  if (!sweeperConfig.enabled) {
    log.info("merge_state_sweeper.disabled", {
      event: "merge_state_sweeper.disabled",
      message: "Merge-state sweeper is disabled (MERGE_STATE_SWEEPER_ENABLED=false).",
    });
    return null;
  }

  if (!deps) {
    log.warn("merge_state_sweeper.missing_domain_services", {
      event: "merge_state_sweeper.missing_domain_services",
      message:
        "MERGE_STATE_SWEEPER_ENABLED=true but domain services not injected. " +
        "Merge-state sweeper will not start.",
    });
    return null;
  }

  log.info("merge_state_sweeper.started", {
    event: "merge_state_sweeper.started",
    intervalMs: sweeperConfig.intervalMs,
    owner: sweeperConfig.owner,
    repo: sweeperConfig.repo,
    ownerDefaulted: sweeperConfig.ownerDefaulted,
    repoDefaulted: sweeperConfig.repoDefaulted,
    githubTimeoutMs: sweeperConfig.githubTimeoutMs,
  });

  // PR #1116 R1 BLOCKING: when owner/repo were silently defaulted, emit a
  // structured warning at boot. In non-Minsky deployments this would otherwise
  // silently target edobry/minsky and never produce a high-signal log line.
  if (sweeperConfig.ownerDefaulted || sweeperConfig.repoDefaulted) {
    log.warn("merge_state_sweeper.using_default_repo_coordinates", {
      event: "merge_state_sweeper.using_default_repo_coordinates",
      owner: sweeperConfig.owner,
      repo: sweeperConfig.repo,
      ownerDefaulted: sweeperConfig.ownerDefaulted,
      repoDefaulted: sweeperConfig.repoDefaulted,
      message:
        "merge-state sweeper is using default repo coordinates. " +
        "Set SWEEPER_REPO_OWNER and SWEEPER_REPO_NAME explicitly in non-Minsky deployments " +
        "to avoid silently sweeping the wrong repository.",
    });
  }

  let isRunning = false;
  // Lazy Octokit creation — subsequent cycles reuse the client. Since mt#2717,
  // createOctokit installs @octokit/auth-app as the `authStrategy`, so the
  // instance mints and TRANSPARENTLY REFRESHES its installation token per
  // request. (Before mt#2717 it held a STATIC token that expired at ~60 min and
  // then 401'd every subsequent call — the reuse below was the bug's blast
  // radius, not a safe optimization.) A single long-lived instance is now
  // genuinely safe across many cycles. mt#2684: octokitOverride (test seam)
  // pre-seeds the promise so the boot catch-up cycle below never calls the real
  // createOctokit.
  let octokitPromise: Promise<Octokit> | null = octokitOverride
    ? Promise.resolve(octokitOverride)
    : null;

  /**
   * Run one sweep cycle, guarded by the reentrancy flag. Shared by both the
   * boot catch-up call (mt#2684) and every periodic `setInterval` tick, so
   * the two paths cannot race each other or double-sweep.
   */
  const runCycle = (): void => {
    if (isRunning) {
      log.warn("merge_state_sweeper.skip_reentrant", {
        event: "merge_state_sweeper.skip_reentrant",
        message: "Previous merge-state sweep still in progress; skipping this interval tick.",
      });
      return;
    }
    isRunning = true;

    (async () => {
      if (!octokitPromise) {
        octokitPromise = createOctokit(config);
      }
      const octokit = await octokitPromise;
      return runMergeStateSweep(
        octokit,
        sweeperConfig.owner,
        sweeperConfig.repo,
        deps,
        sweeperConfig.githubTimeoutMs
      );
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("merge_state_sweeper.cycle_error", {
          event: "merge_state_sweeper.cycle_error",
          error: message,
        });
        // Reset octokitPromise on cycle-level auth-class errors so the next
        // cycle rebuilds the client. Post-mt#2717 the authStrategy instance
        // self-refreshes, so this rebuild is belt-and-suspenders rather than
        // load-bearing (a genuine sustained credential failure is surfaced by
        // the shared auth-health tracker's `reviewer.auth_health_failing` alert);
        // it is retained because rebuilding is harmless and covers the rare
        // cycle-level throw. Never clear a test-injected octokitOverride — it has
        // no "rebuild" path and clearing would make the next tick call the real
        // createOctokit in tests that only provided a fake.
        if (/auth|credentials|401|403/i.test(message) && !octokitOverride) {
          octokitPromise = null;
        }
      })
      .finally(() => {
        isRunning = false;
      });
  };

  // mt#2684: boot catch-up sweep. Run one cycle immediately (not waiting for
  // the first setInterval tick) so a merge whose webhook delivery lands
  // during a redeploy window self-heals right away, instead of depending on
  // this process surviving uninterrupted for a full intervalMs. See
  // module-header "Boot catch-up sweep" for the full diagnosis (mt#2684,
  // mirroring sweeper.ts's mt#2660).
  if (sweeperConfig.bootCatchupEnabled) {
    log.info("merge_state_sweeper.boot_catchup_start", {
      event: "merge_state_sweeper.boot_catchup_start",
      message:
        "Running an immediate merge-state sweep cycle at boot to catch post-merge " +
        "state syncs missed during this process's own redeploy window.",
    });
    runCycle();
  } else {
    // mt#2684: without this line, an operator scanning Railway logs after a
    // redeploy sees no `merge_state_sweeper.boot_catchup_start` and has no
    // way to distinguish "boot catch-up is intentionally disabled" from
    // "something is silently broken". Only reachable when the sweeper itself
    // is enabled and domain services are present — the two early-return
    // paths above (disabled / missing_domain_services) have their own
    // dedicated log lines.
    log.info("merge_state_sweeper.boot_catchup_skipped", {
      event: "merge_state_sweeper.boot_catchup_skipped",
      message:
        "Boot catch-up sweep is disabled (MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED=false) — " +
        "this boot will not self-heal a redeploy-window webhook miss until the " +
        "next periodic sweep tick.",
    });
  }

  const handle = setInterval(runCycle, sweeperConfig.intervalMs);

  return handle;
}
