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
  /**
   * Which transport triggered the review (mt#2679):
   *   - "direct" — authenticated POST /retrigger (mcp.auth.token present).
   *   - "review-comment" — GitHub-auth fallback: a `/review` comment posted on
   *     the PR via the local github.token; the reviewer's issue_comment
   *     handler picks it up asynchronously.
   */
  path?: "direct" | "review-comment";
  deliveryId?: string;
  /** URL of the posted `/review` comment (fallback path only). */
  commentUrl?: string;
  /** Human-readable caveat (e.g. the fallback's async semantics). */
  note?: string;
  error?: string;
}

/**
 * Minimal client seam for the fallback comment post — matches the
 * `octokit.rest.issues.createComment` call shape so tests inject a fake.
 */
export interface ReviewCommentClient {
  createComment(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ data: { html_url?: string } }>;
}

/**
 * GitHub-auth fallback for retrigger (mt#2679): post a `/review` comment on
 * the PR. The reviewer service's issue_comment handler
 * (`services/reviewer/src/server.ts` — `REVIEW_COMMAND_RE`, mt#2127) treats a
 * comment whose FIRST LINE is exactly `/review` from an
 * OWNER/MEMBER/COLLABORATOR author as a retrigger command on the PR's current
 * HEAD. This rides the GitHub credential the operator already has locally
 * (`github.token` → posts as the token's user, association OWNER on own
 * repos), so no shared secret needs distributing for the tool to stay usable.
 *
 * Asynchronous by nature: success here means the COMMENT landed; the review
 * itself fires when the reviewer service processes the webhook. The comment
 * gates to open PRs server-side (closed PRs are skipped) — surfaced in the
 * returned note rather than pre-checked here.
 */
export async function postReviewCommentFallback(
  client: ReviewCommentClient,
  args: { pr: number; owner: string; repo: string }
): Promise<RetriggerResult> {
  try {
    const response = await client.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.pr,
      body: "/review",
    });
    return {
      ok: true,
      pr: args.pr,
      path: "review-comment",
      commentUrl: response.data.html_url,
      note:
        "mcp.auth.token is not set; fell back to posting a `/review` comment via the local " +
        "GitHub credential. The reviewer picks it up asynchronously (open PRs only). " +
        "Run `minsky config doctor --fix` to provision the token and use the direct endpoint.",
    };
  } catch (err) {
    return {
      ok: false,
      pr: args.pr,
      path: "review-comment",
      error: `Fallback /review comment failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a retrigger: direct endpoint when `mcp.auth.token` is present,
 * GitHub-auth `/review`-comment fallback when only `github.token` is, clear
 * both-paths error when neither. Exported so the credential-branching is
 * testable through the real configuration seam (`initializeConfiguration`)
 * without going through the shared-command registry.
 */
export async function runReviewerRetrigger(args: {
  pr: number;
  owner: string;
  repo: string;
}): Promise<RetriggerResult> {
  const { pr, owner, repo } = args;

  // Resolve the reviewer endpoint from the Minsky config system. The URL
  // override (MINSKY_REVIEWER_URL → reviewer.url, mt#2269) and the auth
  // token (MINSKY_MCP_AUTH_TOKEN → mcp.auth.token, mt#2346) are merged
  // into the config by the environment source, so these reads honour
  // config-file values AND env overrides.
  const { getConfiguration } = await import("@minsky/domain/configuration/index");
  const cfg = getConfiguration();

  // GitHub-auth fallback (mt#2679): when the MCP token is absent but a
  // GitHub credential is present, post a `/review` comment instead of
  // erroring — the tool stays usable from any machine with GitHub creds.
  // Both absent → the clear error below names BOTH remediation paths.
  const mcpAuthToken = cfg.mcp?.auth?.token;
  const githubToken = cfg.github?.token;
  if (!mcpAuthToken) {
    if (githubToken) {
      log.cli(
        "mcp.auth.token is not set — falling back to the GitHub-auth `/review` comment path (mt#2679)."
      );
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: githubToken });
      const result = await postReviewCommentFallback(octokit.rest.issues, {
        pr,
        owner,
        repo,
      });
      log.info("reviewer.retrigger.fallback", {
        event: "reviewer.retrigger.fallback",
        pr,
        owner,
        repo,
        ok: result.ok,
        commentUrl: result.commentUrl,
      });
      return result;
    }
    throw new Error(
      "reviewer.retrigger has no usable credential: `mcp.auth.token` is not set (direct " +
        "endpoint auth) AND `github.token` is not set (`/review`-comment fallback). " +
        "Run `minsky config doctor --fix` to provision mcp.auth.token from " +
        "railway-secrets.json, set it via `minsky config set mcp.auth.token <value>` / " +
        "export MINSKY_MCP_AUTH_TOKEN, or configure github.token. The reviewer webhook " +
        "HMAC secret is no longer used for retrigger auth (mt#2346)."
    );
  }

  const {
    url: reviewerUrl,
    authToken,
    usedDefaultUrl,
  } = resolveReviewerEndpoint(cfg.reviewer, mcpAuthToken);

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
    return { ok: false, pr, path: "direct", error: body.error ?? `HTTP ${response.status}` };
  }

  log.info("reviewer.retrigger.success", {
    event: "reviewer.retrigger.success",
    pr,
    deliveryId: body.deliveryId,
  });

  return { ok: true, pr, path: "direct", deliveryId: body.deliveryId };
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
        "Trigger a fresh review on a PR's current HEAD. Uses the reviewer service's /retrigger " +
        "endpoint (mcp.auth.token), falling back to a GitHub-auth `/review` comment when only " +
        "github.token is available (mt#2679).",
      requiresSetup: true,
      parameters: reviewerRetriggerParams,
      execute: async (params): Promise<RetriggerResult> =>
        runReviewerRetrigger({
          pr: params.pr as number,
          owner: params.owner as string,
          repo: params.repo as string,
        }),
    })
  );
}
