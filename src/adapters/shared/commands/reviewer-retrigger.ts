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

export interface RetriggerResult {
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
  /**
   * The direct endpoint this attempt targeted (mt#3143). Present on every
   * direct-path result and on a fallback that followed a direct failure, so an
   * operator can tell WHICH host answered without reading source.
   */
  url?: string;
  /**
   * The direct path's failure, preserved when the `/review`-comment fallback
   * ran because the direct path failed (mt#3143) — the fallback succeeding
   * does not make the direct failure uninteresting.
   */
  directError?: string;
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
 * Non-2xx statuses for which retrying through the `/review`-comment transport is
 * meaningful (mt#3143).
 *
 * 404 / 502 / 503 / 504 mean the request never reached the reviewer's router —
 * the reviewer's own `/retrigger` handler has no 404 path at all
 * (`services/reviewer/src/server.ts`: 503 / 401 / 400 / 422 / 200 / 500 only), so
 * a 404 is a routing verdict: a different app is serving the host, or no
 * deployment is routed to it. 401 means the direct-endpoint credential was
 * rejected. A different transport can plausibly succeed in all of those.
 *
 * Deliberately EXCLUDED:
 *   - 400 / 422 — the reviewer's legitimate refusals (malformed request; PR
 *     closed or draft). A comment fixes neither and would just post noise.
 *   - 500 — the reviewer WAS reached and failed inside its own handler. The
 *     comment path re-enters the same service, so it is not an alternative.
 */
const FALLBACK_ELIGIBLE_STATUSES = new Set([401, 404, 502, 503, 504]);

/**
 * Pull a human-readable message out of an upstream error body.
 *
 * The bodies this must cope with are not one shape:
 *   - the reviewer's own errors: `{"error":"unauthorized"}`
 *   - Railway's unrouted-host 404:
 *     `{"status":"error","code":404,"message":"Application not found"}`
 *   - the reviewer's unmatched-route 404: `not found` (plain text, handled by
 *     the caller's non-JSON branch)
 *
 * Reading only `error` is what made every non-reviewer failure render as a bare
 * `HTTP <status>` with no indication of which host answered — the defect that
 * produced two duplicate task filings against the wrong subsystem (mt#3143).
 */
export function extractUpstreamMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Build the operator-facing description of a failed direct attempt: the full URL
 * that was targeted, the status, and whatever the upstream said (mt#3143).
 */
export function describeDirectFailure(args: {
  pr: number;
  url: string;
  status: number;
  upstreamMessage?: string;
}): RetriggerResult {
  const detail = args.upstreamMessage ? `: ${args.upstreamMessage}` : "";
  return {
    ok: false,
    pr: args.pr,
    path: "direct",
    url: args.url,
    error: `POST ${args.url} returned HTTP ${args.status}${detail}`,
  };
}

async function createReviewCommentClient(githubToken: string): Promise<ReviewCommentClient> {
  const { Octokit } = await import("@octokit/rest");
  const { createTimeoutFetch } = await import("@minsky/domain/github/octokit-timeout");
  const octokit = new Octokit({ auth: githubToken, request: { fetch: createTimeoutFetch() } });
  return octokit.rest.issues;
}

/**
 * Injectable seam for the `/review`-comment client (mt#3143). The fallback now
 * fires on direct-path FAILURE, not only on a missing token, so the failure
 * branches need to be exercisable without a live GitHub call. Production passes
 * nothing and gets the real Octokit-backed client.
 */
export interface RetriggerDependencies {
  createCommentClient?: (githubToken: string) => Promise<ReviewCommentClient>;
}

/**
 * Attempt the `/review`-comment transport after the DIRECT path failed (mt#3143).
 * Returns undefined when no GitHub credential is configured, so the caller can
 * surface the direct failure unchanged.
 *
 * Bounded value, stated rather than implied: this recovers a failure specific to
 * the direct ENDPOINT (route moved, endpoint retired, credential rejected). It
 * does NOT recover a host outage — GitHub delivers the resulting comment's
 * webhook to the same host that just failed, so if the reviewer is down or
 * serving the wrong app, this path produces no review either.
 */
async function attemptCommentFallbackAfterFailure(args: {
  pr: number;
  owner: string;
  repo: string;
  githubToken: string | undefined;
  /** The direct endpoint that was attempted — carried onto the result so a
   * fallback still names the host that failed (mt#3143 PR #2289 R1). */
  url: string;
  directError: string;
  createCommentClient: (githubToken: string) => Promise<ReviewCommentClient>;
}): Promise<RetriggerResult | undefined> {
  const { pr, owner, repo, githubToken, url, directError, createCommentClient } = args;
  if (!githubToken) return undefined;

  log.cli(
    `Direct retrigger failed (${directError}) — falling back to the GitHub-auth \`/review\` comment path.`
  );

  const client = await createCommentClient(githubToken);
  const result = await postReviewCommentFallback(client, { pr, owner, repo });

  log.info("reviewer.retrigger.fallback", {
    event: "reviewer.retrigger.fallback",
    pr,
    owner,
    repo,
    ok: result.ok,
    commentUrl: result.commentUrl,
    trigger: "direct-failure",
    directError,
  });

  return {
    ...result,
    url,
    directError,
    note:
      `The direct endpoint failed (${directError}); fell back to posting a \`/review\` comment ` +
      "via the local GitHub credential. The reviewer picks it up asynchronously (open PRs only). " +
      "If the reviewer host is down or serving the wrong app, this fallback will not produce a " +
      "review either — GitHub delivers the comment's webhook to that same host.",
  };
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
export async function runReviewerRetrigger(
  args: { pr: number; owner: string; repo: string },
  deps: RetriggerDependencies = {}
): Promise<RetriggerResult> {
  const { pr, owner, repo } = args;
  const createCommentClient = deps.createCommentClient ?? createReviewCommentClient;

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
      const client = await createCommentClient(githubToken);
      const result = await postReviewCommentFallback(client, {
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
        trigger: "no-mcp-token",
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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ pr, owner, repo }),
    });
  } catch (err) {
    // No response at all — DNS failure, connection refused, timeout. Name the
    // URL: this is the case where "which host did it even try?" matters most.
    const message = err instanceof Error ? err.message : String(err);
    const failure: RetriggerResult = {
      ok: false,
      pr,
      path: "direct",
      url,
      error: `POST ${url} failed before any response: ${message}`,
    };
    log.error("reviewer.retrigger.failed", {
      event: "reviewer.retrigger.failed",
      pr,
      url,
      error: failure.error,
    });
    return (
      (await attemptCommentFallbackAfterFailure({
        pr,
        owner,
        repo,
        githubToken,
        url,
        directError: failure.error as string,
        createCommentClient,
      })) ?? failure
    );
  }

  // Read the body exactly ONCE. The previous shape called `response.json()` and
  // then `response.text()` inside the catch — but the failed `json()` has already
  // consumed the stream, so `text()` threw "Body already used", the `.catch`
  // swallowed it, and the sanitized-text branch silently produced nothing. Any
  // non-JSON error body (the reviewer's own plain-text `not found`, a proxy's
  // HTML 502) was therefore invisible. Reading text first and parsing it here is
  // what makes that branch reachable at all.
  const rawText = await response.text().catch(() => "");
  let parsedBody: unknown;
  try {
    parsedBody = rawText.length > 0 ? JSON.parse(rawText) : undefined;
  } catch {
    parsedBody = undefined;
  }

  let nonJsonBody: string | undefined;
  if (parsedBody === undefined && rawText.length > 0) {
    // Strip control chars, collapse whitespace, and cap length so a full error
    // page doesn't flood the caller (PR #1855 R1).
    const { safeTruncate } = await import("../../../utils/safe-truncate");
    nonJsonBody =
      safeTruncate(
        rawText
          // eslint-disable-next-line no-control-regex -- deliberately stripping control chars from untrusted error bodies
          .replace(/[\x00-\x1f\x7f]+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        300,
        "head"
      ) || undefined;
  }

  if (!response.ok) {
    const failure = describeDirectFailure({
      pr,
      url,
      status: response.status,
      upstreamMessage: extractUpstreamMessage(parsedBody) ?? nonJsonBody,
    });
    log.error("reviewer.retrigger.failed", {
      event: "reviewer.retrigger.failed",
      pr,
      url,
      status: response.status,
      error: failure.error,
    });

    if (FALLBACK_ELIGIBLE_STATUSES.has(response.status)) {
      const fallback = await attemptCommentFallbackAfterFailure({
        pr,
        owner,
        repo,
        githubToken,
        url,
        directError: failure.error as string,
        createCommentClient,
      });
      if (fallback) return fallback;
    }

    return failure;
  }

  const deliveryId = (parsedBody as { deliveryId?: string } | null | undefined)?.deliveryId;

  log.info("reviewer.retrigger.success", {
    event: "reviewer.retrigger.success",
    pr,
    deliveryId,
  });

  return { ok: true, pr, path: "direct", url, deliveryId };
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
