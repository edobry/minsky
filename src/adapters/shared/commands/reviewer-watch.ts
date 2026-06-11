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
import { makeProductionMissedReviewClient } from "./reviewer-watch-github-client";

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

/** Default poll interval (ms). Mirrors the Railway sweeper's 10-minute cadence. */
const DEFAULT_INTERVAL_MS = 600_000;

/** Default alert threshold — alert on any missed review. */
const DEFAULT_THRESHOLD = 1;

/**
 * Resolve a `ReviewerWatchConfig` from explicit parameters, falling back to
 * environment variables, then to the configured reviewer-bot identity
 * (`reviewer.botLogin` ← `MINSKY_REVIEWER_BOT_LOGIN`, default
 * `minsky-reviewer[bot]` — mt#2392), then to hard-coded defaults. No I/O
 * beyond the in-memory configuration read.
 */
function resolveWatchConfig(params: {
  owner?: string;
  repo?: string;
  botLogin?: string;
  threshold?: number;
}): ReviewerWatchConfig {
  const owner = params.owner ?? process.env["MINSKY_REVIEWER_WATCH_OWNER"] ?? "edobry";
  const repo = params.repo ?? process.env["MINSKY_REVIEWER_WATCH_REPO"] ?? "minsky";
  const botLogin =
    params.botLogin ??
    process.env["MINSKY_REVIEWER_WATCH_BOT_LOGIN"] ??
    resolveBotIdentities().reviewerBotLogin;
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
    description: "GitHub repo owner (default: $MINSKY_REVIEWER_WATCH_OWNER or 'edobry')",
    required: false,
  },
  repo: {
    schema: z.string().min(1).optional(),
    description: "GitHub repo name (default: $MINSKY_REVIEWER_WATCH_REPO or 'minsky')",
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
        const config = resolveWatchConfig({
          owner: params.owner as string | undefined,
          repo: params.repo as string | undefined,
          botLogin: params.botLogin as string | undefined,
          threshold: params.threshold as number | undefined,
        });

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
        const config = resolveWatchConfig({
          owner: params.owner as string | undefined,
          repo: params.repo as string | undefined,
          botLogin: params.botLogin as string | undefined,
          threshold: params.threshold as number | undefined,
        });
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
