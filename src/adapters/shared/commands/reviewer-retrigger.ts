/**
 * Shared reviewer-retrigger command (mt#2127 SC#5).
 *
 * Surfaces a programmatic review retrigger at the CLI / MCP layer.
 *
 * Commands:
 *   reviewer.retrigger — trigger a fresh review on a PR's current HEAD.
 *
 * Calls the reviewer service's POST /retrigger endpoint, which fetches the
 * PR via Octokit and dispatches runReview in-process.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "@minsky/shared/logger";
import type { ReviewerConfig } from "@minsky/domain/configuration/schemas/reviewer";

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

// Fallback reviewer-webhook URL used when neither `reviewer.url` config nor the
// `MINSKY_REVIEWER_URL` env override (mapped to `reviewer.url`) is set. The env
// override is resolved through the config system (mt#2269), not a direct
// `process.env` read here.
const DEFAULT_REVIEWER_URL = "https://minsky-reviewer-webhook.up.railway.app";

// ---------------------------------------------------------------------------
// reviewer.retrigger
// ---------------------------------------------------------------------------

const reviewerRetriggerParams = {
  pr: {
    schema: z.number().int().min(1),
    description: "PR number to retrigger review on",
    required: true,
  },
  owner: {
    schema: z.string().min(1),
    description: "GitHub repo owner",
    required: true,
  },
  repo: {
    schema: z.string().min(1),
    description: "GitHub repo name",
    required: true,
  },
};

interface RetriggerResult {
  ok: boolean;
  pr: number;
  deliveryId?: string;
  error?: string;
}

/**
 * Resolve the reviewer-webhook URL + auth secret from Minsky configuration
 * (mt#2269). Both values flow through the standard config system, so the
 * `MINSKY_REVIEWER_URL` / `MINSKY_REVIEWER_WEBHOOK_SECRET` env vars — registered
 * in `environmentMappings` — override the config-file value via the environment
 * source's higher merge priority. The URL falls back to the hosted default;
 * a missing secret is a hard error with a message that names only the
 * resolution paths that actually exist.
 *
 * Accepts the domain `ReviewerConfig` slice directly (the type of
 * `getConfiguration().reviewer`) to avoid a drifting local duplicate.
 */
export function resolveReviewerEndpoint(reviewer: ReviewerConfig): {
  url: string;
  webhookSecret: string;
} {
  const url = reviewer?.url ?? DEFAULT_REVIEWER_URL;
  const webhookSecret = reviewer?.webhookSecret;

  if (!webhookSecret) {
    throw new Error(
      "reviewer.retrigger requires a reviewer webhook secret to authenticate with the " +
        "reviewer service. Set `reviewer.webhookSecret` in your Minsky config, or export " +
        "MINSKY_REVIEWER_WEBHOOK_SECRET (which maps to `reviewer.webhookSecret`)."
    );
  }

  return { url, webhookSecret };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReviewerRetriggerCommands(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "reviewer.retrigger",
      category: CommandCategory.TOOLS,
      name: "retrigger",
      description:
        "Trigger a fresh review on a PR's current HEAD. Calls the reviewer service's /retrigger endpoint.",
      requiresSetup: true,
      parameters: reviewerRetriggerParams,
      execute: async (params): Promise<RetriggerResult> => {
        const pr = params.pr as number;
        const owner = params.owner as string;
        const repo = params.repo as string;

        // Resolve the reviewer endpoint from the Minsky config system. The
        // env overrides (MINSKY_REVIEWER_URL / MINSKY_REVIEWER_WEBHOOK_SECRET)
        // are merged into `cfg.reviewer` by the environment source (mt#2269),
        // so this single read honours config-file values AND env overrides.
        const { getConfiguration } = await import("@minsky/domain/configuration/index");
        const { url: reviewerUrl, webhookSecret } = resolveReviewerEndpoint(
          getConfiguration().reviewer
        );

        const url = `${reviewerUrl.replace(/\/$/, "")}/retrigger`;

        log.info("reviewer.retrigger", {
          event: "reviewer.retrigger",
          pr,
          owner,
          repo,
          url,
        });

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${webhookSecret}`,
          },
          body: JSON.stringify({ pr, owner, repo }),
        });

        let body: RetriggerResult;
        try {
          body = (await response.json()) as RetriggerResult;
        } catch {
          const text = await response.text().catch(() => "");
          body = { ok: false, pr, error: text || `HTTP ${response.status}` };
        }

        if (!response.ok) {
          log.error("reviewer.retrigger.failed", {
            event: "reviewer.retrigger.failed",
            pr,
            status: response.status,
            error: body.error,
          });
          return { ok: false, pr, error: body.error ?? `HTTP ${response.status}` };
        }

        log.info("reviewer.retrigger.success", {
          event: "reviewer.retrigger.success",
          pr,
          deliveryId: body.deliveryId,
        });

        return { ok: true, pr, deliveryId: body.deliveryId };
      },
    })
  );
}
