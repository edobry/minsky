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

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_REVIEWER_URL =
  process.env["MINSKY_REVIEWER_URL"] ?? "https://minsky-reviewer-webhook.up.railway.app";

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

        const reviewerUrl = DEFAULT_REVIEWER_URL;
        const webhookSecret = process.env["MINSKY_REVIEWER_WEBHOOK_SECRET"];

        if (!webhookSecret) {
          throw new Error(
            "reviewer.retrigger requires MINSKY_REVIEWER_WEBHOOK_SECRET to authenticate " +
              "with the reviewer service. Set it in your environment or Minsky config."
          );
        }

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
