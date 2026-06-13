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
//
// mt#2359: this is the SINGLE source of truth for the default reviewer host —
// the test imports it (rather than re-declaring a literal that can silently
// drift to a different value and mask a bug). The value MUST be the Railway
// auto-generated public domain `<service>-<environment>.up.railway.app`; the
// service is named `minsky-reviewer-webhook` (infra/index.ts) in the
// `production` environment, hence the `-production` suffix. The prior value
// omitted `-production` and 404'd the default retrigger path. The public host
// can't be cheaply derived at runtime (deploy.config.ts holds Railway IDs, not
// the hostname; live derivation needs Railway API creds the operator lacks), so
// this cached constant is intentional — guarded by scripts/smoke-retrigger-default-url.ts
// which probes `/health` so a future drift to a dead host is caught.
export const DEFAULT_REVIEWER_URL = "https://minsky-reviewer-webhook-production.up.railway.app";

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
 * Resolve the reviewer-webhook URL + the auth token from Minsky configuration.
 *
 * URL (mt#2269): `reviewer.url` ← `MINSKY_REVIEWER_URL`, falling back to the
 * hosted default.
 *
 * Auth token (mt#2346): `mcp.auth.token` ← `MINSKY_MCP_AUTH_TOKEN` — the
 * operator->service credential the operator already holds for the hosted Minsky
 * MCP endpoint, which the reviewer service ALSO holds. The reviewer's
 * `/retrigger` endpoint authenticates against this token, NOT the webhook HMAC
 * secret, so on-demand triggering never needs the GitHub-signing secret spread
 * to operator machines. Both values flow through the standard config system
 * (env source has the highest merge priority); a missing token is a hard error
 * naming only the resolution paths that actually exist.
 *
 * Accepts the domain `ReviewerConfig` slice (for the URL) and the resolved MCP
 * auth token (`getConfiguration().mcp?.auth?.token`) directly, to avoid a
 * drifting local config read.
 */
export function resolveReviewerEndpoint(
  reviewer: ReviewerConfig,
  mcpAuthToken: string | undefined
): {
  url: string;
  authToken: string;
  /** True when `reviewer.url` was unset and the Minsky-hosted default applied. */
  usedDefaultUrl: boolean;
} {
  const url = reviewer?.url ?? DEFAULT_REVIEWER_URL;
  const usedDefaultUrl = !reviewer?.url;

  if (!mcpAuthToken) {
    throw new Error(
      "reviewer.retrigger requires the Minsky MCP auth token to authenticate with the " +
        "reviewer service. Set `mcp.auth.token` in your Minsky config, or export " +
        "MINSKY_MCP_AUTH_TOKEN (which maps to `mcp.auth.token`). The reviewer webhook " +
        "HMAC secret is no longer used for retrigger auth (mt#2346)."
    );
  }

  return { url, authToken: mcpAuthToken, usedDefaultUrl };
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

        // Resolve the reviewer endpoint from the Minsky config system. The URL
        // override (MINSKY_REVIEWER_URL → reviewer.url, mt#2269) and the auth
        // token (MINSKY_MCP_AUTH_TOKEN → mcp.auth.token, mt#2346) are merged
        // into the config by the environment source, so these reads honour
        // config-file values AND env overrides.
        const { getConfiguration } = await import("@minsky/domain/configuration/index");
        const cfg = getConfiguration();
        const {
          url: reviewerUrl,
          authToken,
          usedDefaultUrl,
        } = resolveReviewerEndpoint(cfg.reviewer, cfg.mcp?.auth?.token);

        const url = `${reviewerUrl.replace(/\/$/, "")}/retrigger`;

        // Defined absent behavior (mt#2392): when `reviewer.url` is unset, the
        // Minsky-hosted default applies — surface which URL was targeted and
        // how to point at a different deployment, so an external project
        // hitting the wrong reviewer learns the config key instead of
        // debugging an opaque 401/404.
        if (usedDefaultUrl) {
          log.cli(
            `Using the default Minsky-hosted reviewer URL (${DEFAULT_REVIEWER_URL}). ` +
              `Set reviewer.url (or MINSKY_REVIEWER_URL) to target your own reviewer deployment.`
          );
        }

        log.info("reviewer.retrigger", {
          event: "reviewer.retrigger",
          pr,
          owner,
          repo,
          url,
          usedDefaultUrl,
        });

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
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
