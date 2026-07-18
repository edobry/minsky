/**
 * Shared reviewer-watch commands (mt#1310).
 *
 * Surfaces the local reviewer-bot watcher at the CLI / MCP layer.
 *
 * Commands:
 *   reviewer.watch.run    — run one watcher pass; emit alert if needed.
 *   reviewer.watch.start  — run the watcher on a setInterval until SIGINT.
 *
 * Both use the same domain `runReviewerWatchCycle` under the hood. `run` is
 * a one-shot good for cron / debug; `start` is the daemon mode that owns
 * dedup state across cycles. See `feedback_self_authored_pr_merge_constraints`
 * for the operator workaround this fix retires.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "@minsky/shared/logger";
import {
  MissedReviewDedupState,
  runReviewerWatchCycle,
  type ReviewerWatchConfig,
  type ReviewerWatchCycleResult,
} from "@minsky/domain/reviewer-watch";
import { SystemOperatorNotify } from "@minsky/domain/notify/operator-notify";
import { resolveBotIdentities } from "@minsky/domain/configuration/bot-identity";
import { REVIEWER_BOT_LOGIN } from "@minsky/domain/constants";
import { getConfiguration } from "@minsky/domain/configuration";
import {
  extractGitHubRepoFromRemote,
  type GitHubRepoDetectionDeps,
} from "@minsky/domain/tasks/githubBackendConfig";
import { processCwd } from "@minsky/shared/process";
import { makeProductionMissedReviewClient } from "./reviewer-watch-github-client";

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

/** Default poll interval (ms). Mirrors the Railway sweeper's 10-minute cadence. */
const DEFAULT_INTERVAL_MS = 600_000;

/** Default alert threshold — alert on any missed review. */
const DEFAULT_THRESHOLD = 1;

/**
 * Resolve the configured reviewer login defensively. `resolveBotIdentities()`
 * already degrades to the constant when configuration is unavailable, but
 * option resolution for a CLI command must stay robust even if that contract
 * regresses — reviewer-watch worked with pure env/constant fallback before
 * mt#2392 and must never fail earlier than it used to. Exported for tests.
 */
export function resolveConfiguredReviewerLogin(): string {
  try {
    return resolveBotIdentities().reviewerBotLogin;
  } catch {
    return REVIEWER_BOT_LOGIN;
  }
}

/**
 * Injectable dependencies for `resolveWatchConfig`'s owner/repo resolution
 * (mt#2455). Production callers (the two command executors below) call with
 * no deps and get the live configuration system + live git remote; tests
 * inject these to pin each stage of the resolution chain without touching
 * global state.
 */
export interface ResolveWatchConfigDeps {
  /**
   * Overrides the `github.organization` / `github.repository` configuration
   * read. When omitted, reads the live configuration via `getConfiguration()`,
   * degrading to `{}` if configuration is unavailable (mirrors
   * `resolveConfiguredReviewerLogin`'s defensiveness — option resolution for a
   * CLI command must never throw earlier than the fallback chain it replaces).
   */
  githubConfig?: { organization?: string; repository?: string };
  /**
   * Overrides git-remote detection (mirrors `GitHubRepoDetectionDeps` from
   * `extractGitHubRepoFromRemote`). When omitted, uses the real `git remote
   * get-url origin` lookup.
   */
  gitDetection?: GitHubRepoDetectionDeps;
  /** Working directory for the git-origin lookup. Defaults to `processCwd()`. */
  cwd?: string;
}

/** Read `github.organization` / `github.repository` from live configuration. */
function resolveConfiguredGithubRepo(override?: { organization?: string; repository?: string }): {
  organization?: string;
  repository?: string;
} {
  if (override) return override;
  try {
    const cfg = getConfiguration();
    return {
      organization: cfg.github?.organization,
      repository: cfg.github?.repository,
    };
  } catch {
    return {};
  }
}

/**
 * Build the loud "nothing resolved" error required by mt#2455's
 * defined-absent-behavior convention (matches the `botLogin` precedent in
 * this same file, mt#2392): name every resolution path that was checked so
 * an operator on a fresh project learns how to configure reviewer.watch
 * instead of silently watching Minsky's own repo.
 */
function buildUnresolvedOwnerRepoError(partial: { owner?: string; repo?: string }): Error {
  const missing = [!partial.owner && "owner", !partial.repo && "repo"]
    .filter((v): v is string => Boolean(v))
    .join(" and ");
  return new Error(
    `reviewer.watch could not resolve the ${missing} of the repository to watch.\n` +
      "Checked, in order:\n" +
      "  1. explicit --owner / --repo command params\n" +
      "  2. MINSKY_REVIEWER_WATCH_OWNER / MINSKY_REVIEWER_WATCH_REPO env vars\n" +
      "  3. configured github.organization / github.repository\n" +
      "  4. the 'origin' git remote of the current working directory\n" +
      "None resolved a value. Refusing to silently watch a default repo — " +
      "set one of the above (e.g. `minsky config set github.organization <owner>` " +
      "and `minsky config set github.repository <repo>`, or run reviewer.watch from " +
      "inside the target repo's git checkout) to configure reviewer.watch for this project."
  );
}

/** Which resolution stage supplied a resolved owner/repo value. */
type OwnerRepoSourceTier = "params" | "env" | "config" | "origin";

/** Pick the first defined value across params → env → config, tagged with its tier. */
function resolveOwnerRepoField(
  paramValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined
): { value: string | undefined; tier: OwnerRepoSourceTier | undefined } {
  if (paramValue) return { value: paramValue, tier: "params" };
  if (envValue) return { value: envValue, tier: "env" };
  if (configValue) return { value: configValue, tier: "config" };
  return { value: undefined, tier: undefined };
}

/**
 * Resolve `{ owner, repo }` from explicit params, then env vars, then project
 * configuration (`github.organization` / `github.repository`), then the git
 * `origin` remote — throwing loudly when nothing resolves rather than
 * silently watching a default repo (mt#2455; matches the `botLogin`
 * defined-absent-behavior convention from mt#2392 in this same file).
 *
 * Owner and repo are resolved independently per field, so it is possible
 * (though unusual) for them to come from different tiers — e.g. `owner` set
 * via env while `repo` falls through to project config. That combination can
 * name a repo pair that doesn't actually exist together, so a mismatch is
 * logged at warn level for operator visibility (reviewer finding, PR #2052
 * R1) rather than left silent.
 *
 * Exported for tests.
 */
export function resolveWatchOwnerRepo(
  params: { owner?: string; repo?: string },
  deps: ResolveWatchConfigDeps = {}
): { owner: string; repo: string } {
  const envOwner = process.env["MINSKY_REVIEWER_WATCH_OWNER"];
  const envRepo = process.env["MINSKY_REVIEWER_WATCH_REPO"];
  const configuredRepo = resolveConfiguredGithubRepo(deps.githubConfig);

  let ownerResolution = resolveOwnerRepoField(params.owner, envOwner, configuredRepo.organization);
  let repoResolution = resolveOwnerRepoField(params.repo, envRepo, configuredRepo.repository);

  if (!ownerResolution.value || !repoResolution.value) {
    const cwd = deps.cwd ?? processCwd();
    const origin = extractGitHubRepoFromRemote(cwd, deps.gitDetection);
    if (!ownerResolution.value && origin?.owner) {
      ownerResolution = { value: origin.owner, tier: "origin" };
    }
    if (!repoResolution.value && origin?.repo) {
      repoResolution = { value: origin.repo, tier: "origin" };
    }
  }

  const { value: owner, tier: ownerTier } = ownerResolution;
  const { value: repo, tier: repoTier } = repoResolution;

  if (!owner || !repo) {
    throw buildUnresolvedOwnerRepoError({ owner, repo });
  }

  if (ownerTier !== repoTier) {
    log.warn(
      "reviewer-watch: owner and repo resolved from different sources — verify this is the " +
        "intended repository pair",
      { owner, ownerSource: ownerTier, repo, repoSource: repoTier }
    );
  }

  return { owner, repo };
}

/**
 * Resolve a `ReviewerWatchConfig` from explicit parameters, falling back to
 * environment variables, then project configuration, then the git origin
 * remote for owner/repo (mt#2455); and to environment variables, then the
 * configured reviewer-bot identity (`reviewer.botLogin` ←
 * `MINSKY_REVIEWER_BOT_LOGIN`, default `minsky-reviewer[bot]` — mt#2392) for
 * botLogin. Throws when owner/repo cannot be resolved from any source — see
 * `resolveWatchOwnerRepo`. Exported for tests.
 */
export function resolveWatchConfig(
  params: {
    owner?: string;
    repo?: string;
    botLogin?: string;
    threshold?: number;
  },
  deps: ResolveWatchConfigDeps = {}
): ReviewerWatchConfig {
  const { owner, repo } = resolveWatchOwnerRepo(params, deps);
  const botLogin =
    params.botLogin ??
    process.env["MINSKY_REVIEWER_WATCH_BOT_LOGIN"] ??
    resolveConfiguredReviewerLogin();
  const threshold =
    params.threshold ??
    parseInt(process.env["MINSKY_REVIEWER_WATCH_THRESHOLD"] ?? `${DEFAULT_THRESHOLD}`, 10);

  return {
    owner,
    repo,
    botLogin,
    threshold: Number.isNaN(threshold) || threshold < 1 ? DEFAULT_THRESHOLD : threshold,
  };
}

/**
 * The production dependency set for `resolveWatchConfig`'s owner/repo
 * resolution: the real Minsky configuration system (`getConfiguration()`),
 * the real `git remote get-url origin` lookup, and the real process cwd.
 * Threaded explicitly from both command executors below (reviewer finding,
 * PR #2052 R1/R2) so the live-source dependency boundary is visible and
 * testable at the call site, rather than resting on `resolveWatchOwnerRepo`'s
 * internal per-field defaults — this is the one place a future caller (e.g.
 * a daemon invocation rooted at a different working directory) would swap in
 * a different deps set.
 */
function productionWatchConfigDeps(): ResolveWatchConfigDeps {
  return {
    githubConfig: resolveConfiguredGithubRepo(),
    gitDetection: undefined,
    cwd: processCwd(),
  };
}

/** Build a TokenProvider from the project's standard configuration. */
async function buildTokenProviderFromConfig(): Promise<{
  tokenProvider: import("@minsky/domain/auth").TokenProvider;
}> {
  try {
    const { getConfiguration } = await import("@minsky/domain/configuration/index");
    const { createTokenProvider } = await import("@minsky/domain/auth");
    const cfg = getConfiguration();
    const userToken = cfg.github?.token ?? "";
    const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);
    return { tokenProvider };
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      "reviewer.watch requires Minsky configuration to be initialized. " +
        "Run `minsky setup` (or the appropriate init step) before calling reviewer.watch.run / reviewer.watch.start. " +
        `Cause: ${cause}`,
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
}

// ---------------------------------------------------------------------------
// reviewer.watch.run
// ---------------------------------------------------------------------------

const reviewerWatchRunParams = {
  owner: {
    schema: z.string().min(1).optional(),
    description:
      "GitHub repo owner. Resolved in order: this param, $MINSKY_REVIEWER_WATCH_OWNER, " +
      "configured github.organization, the git 'origin' remote. Errors if none resolve.",
    required: false,
  },
  repo: {
    schema: z.string().min(1).optional(),
    description:
      "GitHub repo name. Resolved in order: this param, $MINSKY_REVIEWER_WATCH_REPO, " +
      "configured github.repository, the git 'origin' remote. Errors if none resolve.",
    required: false,
  },
  botLogin: {
    schema: z.string().min(1).optional(),
    description:
      "Reviewer-bot login to detect (default: $MINSKY_REVIEWER_WATCH_BOT_LOGIN, then the configured reviewer.botLogin, then 'minsky-reviewer[bot]')",
    required: false,
  },
  threshold: {
    schema: z.number().int().min(1).optional(),
    description:
      "Min missed reviews to fire alert (default: $MINSKY_REVIEWER_WATCH_THRESHOLD or 1)",
    required: false,
  },
};

// ---------------------------------------------------------------------------
// reviewer.watch.start
// ---------------------------------------------------------------------------

const reviewerWatchStartParams = {
  ...reviewerWatchRunParams,
  intervalMs: {
    schema: z.number().int().min(1000).optional(),
    description:
      "Poll interval in ms (default: $MINSKY_REVIEWER_WATCH_INTERVAL_MS or 600000 = 10 min)",
    required: false,
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the reviewer-watch commands in the shared command registry.
 */
export function registerReviewerWatchCommands(): void {
  // -------------------------------------------------------------------------
  // reviewer.watch.run — one-shot
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "reviewer.watch.run",
      category: CommandCategory.TOOLS,
      name: "run",
      description:
        "Run one reviewer-watch pass: scan open PRs, detect missing minsky-reviewer reviews, fire OperatorNotify if above threshold. One-shot (no dedup across invocations); use `reviewer.watch.start` for the daemon.",
      requiresSetup: true,
      parameters: reviewerWatchRunParams,
      execute: async (params): Promise<ReviewerWatchCycleResult> => {
        const config = resolveWatchConfig(
          {
            owner: params.owner as string | undefined,
            repo: params.repo as string | undefined,
            botLogin: params.botLogin as string | undefined,
            threshold: params.threshold as number | undefined,
          },
          productionWatchConfigDeps()
        );

        const { tokenProvider } = await buildTokenProviderFromConfig();
        const client = makeProductionMissedReviewClient(tokenProvider);
        const operatorNotify = new SystemOperatorNotify();
        const dedupState = new MissedReviewDedupState();

        return runReviewerWatchCycle({ client, operatorNotify, dedupState, config });
      },
    })
  );

  // -------------------------------------------------------------------------
  // reviewer.watch.start — daemon
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "reviewer.watch.start",
      category: CommandCategory.TOOLS,
      name: "start",
      description:
        "Start the reviewer-watch daemon: polls every intervalMs, fires OperatorNotify on missed-review onsets. In-memory dedup persists across cycles. Runs until SIGINT.",
      requiresSetup: true,
      parameters: reviewerWatchStartParams,
      execute: async (params): Promise<{ started: true; intervalMs: number }> => {
        const config = resolveWatchConfig(
          {
            owner: params.owner as string | undefined,
            repo: params.repo as string | undefined,
            botLogin: params.botLogin as string | undefined,
            threshold: params.threshold as number | undefined,
          },
          productionWatchConfigDeps()
        );
        const intervalMs =
          (params.intervalMs as number | undefined) ??
          (parseInt(
            process.env["MINSKY_REVIEWER_WATCH_INTERVAL_MS"] ?? `${DEFAULT_INTERVAL_MS}`,
            10
          ) ||
            DEFAULT_INTERVAL_MS);

        const { tokenProvider } = await buildTokenProviderFromConfig();
        const client = makeProductionMissedReviewClient(tokenProvider);
        const operatorNotify = new SystemOperatorNotify();
        const dedupState = new MissedReviewDedupState();

        log.info("reviewer-watch: daemon starting", {
          owner: config.owner,
          repo: config.repo,
          intervalMs,
          threshold: config.threshold,
        });

        let isRunning = false;

        const tick = async (): Promise<void> => {
          if (isRunning) {
            log.warn("reviewer-watch: skipping tick — previous cycle still running");
            return;
          }
          isRunning = true;
          try {
            const result = await runReviewerWatchCycle({
              client,
              operatorNotify,
              dedupState,
              config,
            });
            log.debug("reviewer-watch: cycle done", {
              decision: result.decision,
              missing: result.missing.length,
              alerted: result.alerted,
            });
          } catch (err: unknown) {
            log.error("reviewer-watch: cycle errored (loop continues)", {
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            isRunning = false;
          }
        };

        // Fire one cycle immediately so the operator sees a result without
        // waiting `intervalMs`. This matches the Ask reconciler / pr-watch
        // operational expectation: "I started the daemon — it should do
        // something now," not "it'll do something in 10 minutes."
        await tick();

        setInterval(() => {
          void tick();
        }, intervalMs);

        // Cleanup is not registered: terminating signals will exit the process,
        // and Bun clears the interval as part of process teardown. The CLI
        // entry point is the daemon's lifetime, so explicit clearInterval on
        // SIGINT is not needed for v1.

        return { started: true, intervalMs };
      },
    })
  );
}
