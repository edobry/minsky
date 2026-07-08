/**
 * deploy.smoke system-event bridge (mt#2599).
 *
 * "Smoke" here is Minsky's own `bundle-boot-smoke` GitHub Actions check-run
 * (CLAUDE.md `§Bundle-Boot Smoke Gate`, `.github/workflows/bundle-boot-smoke.yml`)
 * — a completely separate system from the Railway deploy-platform pipeline
 * that `deploy.build`/`deploy.live`/`deploy.fail` bridge
 * (`src/adapters/shared/commands/deployment.ts`). There is no Railway-native
 * seam for it, so this bridge polls the GitHub Checks API directly.
 *
 * ## Design: poll, not webhook
 *
 * mt#2599's hard boundary rules out a webhook RECEIVER inside
 * `services/reviewer/**` (the natural home for a GitHub-webhook endpoint in
 * this codebase) — so the alternative named by the task is polling from the
 * main-service/cockpit side. This module is that poll.
 *
 * ## What commit are we checking?
 *
 * The bundle-boot-smoke workflow runs on every push to `main` AND on every
 * PR — so "the commit" is ambiguous unless scoped. This bridge scopes it to
 * **the exact commit the calling cockpit process itself was deployed from**,
 * read from Railway's `RAILWAY_GIT_COMMIT_SHA` environment variable (Railway
 * sets this automatically for GitHub-triggered deployments — see
 * https://docs.railway.com/reference/variables). That SHA is on the SAME
 * monorepo/single-push as whatever triggered bundle-boot-smoke for that
 * commit, so checking it answers a concrete, useful question: "did the code
 * currently running in this cockpit process pass its own boot-smoke check?"
 *
 * When `RAILWAY_GIT_COMMIT_SHA` is absent (local dev, a non-Railway
 * environment, or a deploy not triggered from GitHub), the sweep no-ops —
 * there is no commit to check standing in for "the deploy in question."
 *
 * ## Invocation path (CLAUDE.md "Invocation path required for event/poll
 * mechanisms")
 *
 * `startDeploySmokeSweeper` (`src/cockpit/sweepers.ts`) registers a periodic
 * tick via `createIntervalSweeper`, wired into the running cockpit server at
 * boot from `src/commands/cockpit/start-command.ts` (mirroring the other
 * five sweepers there: ask-advancement, prod-state, topology, transcript
 * sweep backstop, dispatch watchdog). The cockpit process is itself a
 * long-lived deployed Railway service, so this is a real production caller,
 * not a stub — `triggerDeploySmokeSweep` below has no other caller in `src/`
 * besides its own test file, by design (the sweeper is the ONLY production
 * invocation path).
 *
 * ## Dedup
 *
 * In-memory only (`lastEmittedSha`), NOT persisted to disk. Unlike the
 * mcp.disconnect bridge's on-disk HWM (`src/mcp/disconnect-event-sweep.ts`,
 * needed because the MCP server restarts every few minutes as routine
 * harness behavior), the cockpit process's `RAILWAY_GIT_COMMIT_SHA` only
 * changes when the process itself redeploys onto a new commit — a fresh
 * process boot always has a fresh (or absent) SHA to track, so there is
 * nothing to recover across a restart: the module-level flag naturally
 * resets exactly when it should.
 *
 * The flag advances ONLY on confirmed persistence:
 * `emitSystemEventFromProvider` returns whether a row was actually written,
 * and a no-op emit (provider absent / non-SQL / DB down, e.g. a boot race)
 * leaves the flag unset so the next tick retries instead of permanently
 * dropping the event for that commit.
 */
import { log } from "@minsky/shared/logger";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import { emitSystemEventFromProvider } from "@minsky/domain/events/emit-best-effort";

/** The check-run name the bundle-boot-smoke workflow reports (its `jobs.<id>.name`). */
export const BUNDLE_BOOT_SMOKE_CHECK_NAME = "bundle-boot-smoke";

/** Minimal check-run shape this module needs — matches `CheckRunResult` from
 * `packages/domain/src/repository/github-pr-checks.ts` structurally, without
 * importing its Octokit-adjacent module graph into this file's type surface. */
export interface CheckRunLike {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Pure: derive the `deploy.smoke` status from a list of check-runs for a
 * commit, or `null` when the `bundle-boot-smoke` check hasn't completed yet
 * (still queued/in_progress) or isn't present at all. Exported for direct
 * unit testing without a live GitHub API.
 *
 * Any non-`"success"` conclusion (`failure`, `cancelled`, `timed_out`,
 * `action_required`, `neutral`, `skipped`, or `null` while `status` is
 * somehow `"completed"`) maps to `"failure"` — this bridge only distinguishes
 * "the boot-smoke gate passed" from "it didn't," matching the gate's own
 * pass/fail framing (CLAUDE.md `§Bundle-Boot Smoke Gate` denies merge unless
 * the check "concluded success").
 */
export function deriveSmokeStatus(checks: CheckRunLike[]): "success" | "failure" | null {
  const run = checks.find((c) => c.name === BUNDLE_BOOT_SMOKE_CHECK_NAME);
  if (!run || run.status !== "completed") return null;
  return run.conclusion === "success" ? "success" : "failure";
}

// ---------------------------------------------------------------------------
// In-memory dedup — see module doc block for why this doesn't need a
// persisted HWM the way the mcp.disconnect bridge does.
// ---------------------------------------------------------------------------

let lastEmittedSha: string | null = null;

/** Test seam: reset the module-level dedup state between tests. */
export function resetDeploySmokeSweepStateForTests(): void {
  lastEmittedSha = null;
}

// ---------------------------------------------------------------------------
// Injectable deps — production wiring vs. test fakes
// ---------------------------------------------------------------------------

export interface DeploySmokeSweepDeps {
  /** The commit SHA to check, or null when there is none to check (see module doc). */
  getCommitSha: () => string | null;
  /** Fetch check-runs for the given commit SHA. */
  fetchChecksForSha: (sha: string) => Promise<CheckRunLike[]>;
}

/**
 * Build the real production deps: `RAILWAY_GIT_COMMIT_SHA` for the commit,
 * and a config-driven TokenProvider + Octokit for the GitHub Checks API call
 * — mirrors `buildTokenProviderFromConfig` in
 * `src/adapters/shared/commands/pr-watch.ts` / `reviewer-watch.ts`, but
 * container-free (this sweeper has no `CommandExecutionContext`; it reads
 * project configuration directly, the same way `getRepositoryBackendFromConfig`
 * is designed to be called).
 *
 * Returns `null` when the project's repository backend isn't GitHub-configured
 * (nothing to query check-runs against).
 */
async function buildRealDeps(): Promise<DeploySmokeSweepDeps | null> {
  const { getRepositoryBackendFromConfig } = await import(
    "@minsky/domain/session/repository-backend-detection"
  );
  const { github } = await getRepositoryBackendFromConfig();
  if (!github) {
    log.debug("deploy-smoke-sweep: no GitHub repository backend configured, skipping");
    return null;
  }

  return {
    getCommitSha: () => {
      const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
      return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
    },
    fetchChecksForSha: async (sha: string): Promise<CheckRunLike[]> => {
      const { getConfiguration } = await import("@minsky/domain/configuration/index");
      const { createTokenProvider } = await import("@minsky/domain/auth");
      const { createOctokit } = await import("@minsky/domain/repository/github-pr-operations");
      const { getCheckRunsForRef } = await import("@minsky/domain/repository/github-pr-checks");

      const cfg = getConfiguration();
      const tokenProvider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
      const token = await tokenProvider.getServiceToken(`${github.owner}/${github.repo}`);
      const octokit = createOctokit(token);
      const result = await getCheckRunsForRef(github, sha, octokit);
      return result.checks;
    },
  };
}

/**
 * Sweep tick: check whether the bundle-boot-smoke check-run for this
 * process's own deployed commit has completed, and emit a best-effort
 * `deploy.smoke` system event (once per distinct commit) if so.
 *
 * Never throws — every failure path (no commit SHA, no GitHub backend, API
 * error, emit failure) logs and returns.
 *
 * @param persistenceProvider - held directly (not resolved from a DI
 *   container — sweepers have no `CommandExecutionContext`), per the mt#2537
 *   template's `emitSystemEventFromProvider` variant.
 * @param deps - injectable for tests; defaults to the real production path.
 */
export async function triggerDeploySmokeSweep(
  persistenceProvider: PersistenceProvider | undefined,
  deps?: DeploySmokeSweepDeps
): Promise<void> {
  try {
    const resolvedDeps = deps ?? (await buildRealDeps());
    if (!resolvedDeps) return;

    const sha = resolvedDeps.getCommitSha();
    if (!sha) {
      log.debug(
        "deploy-smoke-sweep: no RAILWAY_GIT_COMMIT_SHA (not a GitHub-triggered Railway deploy), skipping"
      );
      return;
    }
    if (sha === lastEmittedSha) return; // already emitted for this deploy's commit

    const checks = await resolvedDeps.fetchChecksForSha(sha);
    const status = deriveSmokeStatus(checks);
    if (status === null) {
      log.debug("deploy-smoke-sweep: bundle-boot-smoke not completed yet, will retry", { sha });
      return; // not completed (or not present) yet — retry next tick
    }

    const emitted = await emitSystemEventFromProvider(persistenceProvider, {
      eventType: "deploy.smoke",
      payload: { phase: "smoke", sha, status },
    });
    if (!emitted) {
      // Do NOT advance the dedup flag on a no-op emit (provider absent /
      // non-SQL / DB unavailable) — advancing it would permanently suppress
      // deploy.smoke for this commit. Leaving it unset retries next tick.
      log.warn("deploy-smoke-sweep: deploy.smoke emit no-oped, will retry next tick", {
        sha,
        status,
      });
      return;
    }
    lastEmittedSha = sha;
    log.debug("deploy-smoke-sweep: emitted deploy.smoke", { sha, status });
  } catch (err) {
    log.warn("deploy-smoke-sweep: sweep failed (best-effort, swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
