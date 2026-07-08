/**
 * minsky-reviewer webhook server.
 *
 * Stateless HTTP service. Receives GitHub webhooks, verifies signatures,
 * dispatches to the review worker, posts results back to GitHub.
 *
 * Deploys to Railway (or any Node-compatible target). See DEPLOY.md.
 */

// MUST be the first import (mt#2450): tsyringe (used by the domain container,
// mt#2121) requires the reflect-metadata polyfill before any decorated class
// loads. Without this, bootDomainContainer() throws at every production boot
// and the service silently degrades (no pr-watch scheduler, no merge-state
// sweeper, no tier resolution, no circuit-breaker→Ask path) behind a single
// warn-level log line — the mt#1596 "logging ≠ surfacing" failure class.
import "reflect-metadata";
import { Webhooks } from "@octokit/webhooks";
import type { ReviewerConfig } from "./config";
import { loadConfig, parsePositiveIntEnv } from "./config";
import { log } from "./logger";
import type { ReviewResult } from "./review-worker";
import { runReview } from "./review-worker";
import { loadSweeperConfig, startSweeper } from "./sweeper";
import { buildAlertSink, loadAlertSinkConfig, type AlertSink } from "./alert-sink";
import { loadPrWatchSchedulerConfig, startPrWatchScheduler } from "./pr-watch-scheduler";
import {
  loadAsksReconcileSchedulerConfig,
  startAsksReconcileScheduler,
} from "./asks-reconcile-scheduler";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { callMcp } from "./mcp-client";
import { loadMergeStateSweeperConfig, startMergeStateSweeper } from "./merge-state-sweeper";
import { loadAdoptionSweeperConfig, startAdoptionSweeper } from "./adoption-sweeper";
import { getDb, type ReviewerDb } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { bootDomainContainer, type DomainServices } from "./domain-container";
import {
  recordWebhookReceipt,
  updateOutcome,
  pruneOldRows,
  extractPersistedHeaders,
} from "./webhook-events";
import {
  createOctokit,
  getAppIdentity,
  fetchPriorReviews,
  fetchReviewThreads,
  resolveThread,
  dismissReview,
} from "./github-client";
import {
  upsertStatusComment,
  buildPendingBody,
  buildInProgressBody,
  buildCompletedBody,
  buildErrorBody,
  buildSkippedBody,
  buildResolvedBody,
} from "./status-comment";

interface PullRequestPayload {
  pull_request: {
    number: number;
    user: { login: string };
    draft: boolean;
    head: { sha: string };
  };
  repository: { owner: { login: string }; name: string };
}

/**
 * Payload shape for pull_request.closed events.
 * The @octokit/webhooks library validates the signature before dispatching;
 * the `merged` and `merge_commit_sha` fields come from GitHub's documented PR event shape.
 * Runtime type guard (isMergedClosedPayload) is applied before acting.
 */
interface PullRequestClosedPayload {
  action: "closed";
  pull_request: {
    number: number;
    merged: boolean;
    merge_commit_sha: string | null;
    merged_at: string | null;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  repository: { owner: { login: string }; name: string };
}

/**
 * Recognized /review command pattern. The ENTIRE first line of the comment
 * (trimmed) must be exactly `/review` — no surrounding text. This matches
 * acceptance test #3: "Comment `some text /review more text` → no action."
 * Multi-line comments are supported: only the first line is checked.
 */
const REVIEW_COMMAND_RE = /^\s*\/review\s*$/;

/**
 * Recognized /resolve command pattern (mt#2173). Same shape as /review —
 * the entire first line must be exactly `/resolve`.
 */
const RESOLVE_COMMAND_RE = /^\s*\/resolve\s*$/;

/** Author associations that are allowed to trigger /review. */
const ALLOWED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * Type guard: payload is a closed+merged PR event.
 *
 * Narrowing target is just `PullRequestClosedPayload` (without an extra
 * `pull_request: { merged: true }` literal-narrowing intersection) because
 * intersecting our local subset shape with the @octokit-provided event type
 * caused TypeScript to collapse the result to `never` under the stricter
 * services/reviewer tsconfig (PR #1010 R3).
 */
function isMergedClosedPayload(payload: unknown): payload is PullRequestClosedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p["action"] !== "closed") return false;
  const pr = p["pull_request"] as Record<string, unknown> | undefined;
  if (!pr) return false;
  return pr["merged"] === true;
}

/** Extract a Minsky task ID from a GitHub head branch name (e.g. "task/mt-1614" → "mt#1614"). */
export function extractTaskIdFromBranch(headRef: string): string | null {
  // Matches: task/mt-1614, task/mt-123-fixups, task/mt-1234/cleanup, task/mt-99_v2.
  // The numeric ID is captured from the start; any [-/_.] separator + suffix is
  // accepted (PR #1010 R1 NB: relax from `^task/mt-(\d+)$`).
  const match = /^task\/mt-(\d+)(?:[-/_.].*)?$/.exec(headRef);
  if (match) {
    return `mt#${match[1]}`;
  }
  return null;
}

/** Dependency-injectable runReview signature for testing. */
export type RunReviewFn = (
  config: ReviewerConfig,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin: string,
  deliveryId?: string,
  headSha?: string,
  deps?: import("./review-worker").RunReviewDeps
) => Promise<ReviewResult>;

/**
 * Core application factory. Returns the Bun server handle and a
 * gracefulShutdown function bound to that server instance.
 *
 * Accepts an optional `runReviewFn` override for testing — production always
 * uses the real `runReview` from review-worker.ts.
 *
 * Accepts an optional `db` handle for convergence metric persistence.
 * When provided, each review write is attempted; errors are swallowed.
 * When absent (test environments), metric persistence is skipped.
 *
 * Exported for testability; the module-level startup below calls this with
 * the real config and the real runReview.
 */
export function createApp(
  cfg: ReviewerConfig,
  runReviewFn: RunReviewFn = runReview,
  db?: ReviewerDb,
  domainServices?: DomainServices,
  // mt#2451: the external alert sink, shared with the sweeper (single instance
  // built once at server start). When omitted (tests / standalone createApp),
  // the /alert-test route builds one from env via loadAlertSinkConfig().
  alertSink?: AlertSink | null
): {
  server: ReturnType<typeof Bun.serve>;
  gracefulShutdown: () => Promise<void>;
} {
  const webhooks = new Webhooks({ secret: cfg.webhookSecret });

  /** Module-scope set of in-flight review promises within this app instance. */
  const inflight: Set<Promise<unknown>> = new Set();

  async function updateStatusCommentSafe(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    try {
      const octokit = await createOctokit(cfg);
      const { login: botLogin } = await getAppIdentity(cfg);
      await upsertStatusComment(
        octokit,
        owner,
        repo,
        prNumber,
        body,
        botLogin,
        cfg.githubTimeoutMs
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("status_comment.update_failed", {
        event: "status_comment.update_failed",
        pr: prNumber,
        owner,
        repo,
        error: message,
      });
    }
  }

  /**
   * Handle the /resolve comment command (mt#2173).
   *
   * Resolves all unresolved bot-authored review threads via GraphQL
   * `resolveReviewThread`, then dismisses all bot CHANGES_REQUESTED reviews
   * via REST `pulls.dismissReview`. Both operations are best-effort — a
   * single failure logs but doesn't abort the rest.
   */
  async function handleResolveCommand(
    octokit: Awaited<ReturnType<typeof createOctokit>>,
    owner: string,
    repo: string,
    prNumber: number,
    deliveryId: string
  ): Promise<void> {
    const { login: botLogin } = await getAppIdentity(cfg);

    let threadsResolved = 0;
    let reviewsDismissed = 0;

    try {
      const threads = await fetchReviewThreads(octokit, owner, repo, prNumber);
      const botThreads = threads.filter(
        (t) =>
          !t.isResolved && t.comments.length > 0 && t.comments.some((c) => c.author === botLogin)
      );

      for (const thread of botThreads) {
        try {
          await resolveThread(octokit, thread.id);
          threadsResolved++;
        } catch (err: unknown) {
          log.warn("resolve_command.thread_resolve_failed", {
            event: "resolve_command.thread_resolve_failed",
            delivery_id: deliveryId,
            pr: prNumber,
            threadId: thread.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err: unknown) {
      log.warn("resolve_command.thread_fetch_failed", {
        event: "resolve_command.thread_fetch_failed",
        delivery_id: deliveryId,
        pr: prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const reviews = await fetchPriorReviews(octokit, owner, repo, prNumber, cfg.githubTimeoutMs);
      // Defensive author check: fetchPriorReviews already filters via isBotReviewerEntry,
      // but explicitly enforce `userLogin === botLogin` here so a future change to the
      // upstream filter (e.g. broadening to multiple bot identities) cannot accidentally
      // dismiss a human-authored CHANGES_REQUESTED review.
      const staleReviews = reviews.filter(
        (r) => r.state === "CHANGES_REQUESTED" && r.userLogin === botLogin
      );

      for (const review of staleReviews) {
        try {
          await dismissReview(
            octokit,
            owner,
            repo,
            prNumber,
            review.id,
            "Dismissed by /resolve comment command",
            cfg.githubTimeoutMs
          );
          reviewsDismissed++;
        } catch (err: unknown) {
          log.warn("resolve_command.review_dismiss_failed", {
            event: "resolve_command.review_dismiss_failed",
            delivery_id: deliveryId,
            pr: prNumber,
            reviewId: review.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err: unknown) {
      log.warn("resolve_command.review_fetch_failed", {
        event: "resolve_command.review_fetch_failed",
        delivery_id: deliveryId,
        pr: prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info("resolve_command.completed", {
      event: "resolve_command.completed",
      delivery_id: deliveryId,
      pr: prNumber,
      threadsResolved,
      reviewsDismissed,
    });

    await updateStatusCommentSafe(
      owner,
      repo,
      prNumber,
      buildResolvedBody({ threadsResolved, reviewsDismissed })
    );
  }

  /**
   * MCP tool caller for the at-merge webhook handler.
   *
   * Thin adapter over the shared {@link callMcp} helper (mt#1821) — preserves
   * the legacy `string | null` return shape so the at-merge handler callsites
   * don't change. The shared helper performs the MCP initialize handshake
   * and caches the session id; without it the server rejected every
   * `tools/call` with `-32600 "first request must be initialize"` and the
   * at-merge state-sync silently no-op'd.
   *
   * Timeout: 15s, matching the prior in-file `AbortController` + `setTimeout`
   * implementation (per PR #1010 R1 — without a timeout, a hung MCP call
   * kept the detached promise in `inflight` indefinitely). Passed explicitly
   * so any future change to the helper's default does not silently regress
   * the inflight-drain behavior on shutdown.
   *
   * Observability: `callMcp` emits structured `log.warn` events with the
   * `at_merge_handler.mcp` prefix; the legacy
   * `at_merge_handler.mcp_fetch_error` event is preserved.
   */
  async function callMcpToolLocal(
    mcpUrl: string,
    mcpToken: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string | null> {
    const result = await callMcp(
      toolName,
      args,
      { mcpUrl, mcpToken },
      { logPrefix: "at_merge_handler.mcp", timeoutMs: 15_000 }
    );
    return result.ok ? result.contentText : null;
  }

  /**
   * Schedule a review as a detached promise. Calling code returns 200
   * immediately — never await this.
   *
   * Failures are caught and logged as event=review_error. The sweeper
   * (mt#1260) is already live on main as the safety net.
   *
   * Persistence: updates the webhook_events row outcome as the review
   * progresses: reviewer_called → review_submitted OR failed_at_reviewer.
   * Errors from persistence calls are swallowed (see webhook-events.ts).
   */
  function startDetachedReview(
    owner: string,
    repo: string,
    prNumber: number,
    prAuthor: string,
    headSha: string,
    deliveryId: string
  ): void {
    // Mark that the reviewer was called (detached review started).
    if (db !== undefined) {
      void updateOutcome(db, deliveryId, "reviewer_called");
    }

    void updateStatusCommentSafe(owner, repo, prNumber, buildInProgressBody());

    const reviewStartMs = Date.now();
    const promise: Promise<unknown> = runReviewFn(
      cfg,
      owner,
      repo,
      prNumber,
      prAuthor,
      deliveryId,
      headSha,
      {
        ...(db !== undefined ? { db } : {}),
        ...(domainServices
          ? {
              taskService: domainServices.taskService,
              persistenceProvider: domainServices.persistenceProvider,
            }
          : {}),
      }
    )
      .then((result) => {
        log.info("review_result", {
          event: "review_result",
          delivery_id: deliveryId,
          sha: headSha,
          pr: prNumber,
          owner,
          repo,
          status: result.status,
          reason: result.reason,
          tier: result.tier,
          scope: result.scope,
          reviewUrl: result.review?.htmlUrl,
          provider: result.providerUsed,
          model: result.providerModel,
          usage: result.usage,
          taskSpecFetch: result.taskSpecFetch,
        });

        const durationMs = Date.now() - reviewStartMs;
        if (result.status === "reviewed") {
          void updateStatusCommentSafe(
            owner,
            repo,
            prNumber,
            buildCompletedBody(result, durationMs)
          );
        } else if (result.status === "skipped") {
          void updateStatusCommentSafe(owner, repo, prNumber, buildSkippedBody(result.reason));
        } else {
          void updateStatusCommentSafe(owner, repo, prNumber, buildErrorBody(result.reason));
        }

        // Persist final outcome: review_submitted on success, failed_at_reviewer otherwise.
        if (db !== undefined) {
          const outcome = result.status === "reviewed" ? "review_submitted" : "failed_at_reviewer";
          void updateOutcome(
            db,
            deliveryId,
            outcome,
            outcome === "failed_at_reviewer"
              ? {
                  message: result.reason ?? "review did not complete with status=reviewed",
                  stage: "reviewer",
                }
              : undefined
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;

        void updateStatusCommentSafe(owner, repo, prNumber, buildErrorBody(message));

        log.error("review_error", {
          event: "review_error",
          delivery_id: deliveryId,
          sha: headSha,
          pr: prNumber,
          owner,
          repo,
          error: message,
        });

        // Persist failure and surface as operator-visible alert.
        // This is the service-side OperatorNotify equivalent (mt#1372):
        // the reviewer service runs on Railway where structured log.error
        // is the operator-visible channel. Distinct from mt#1310 (missing
        // review alert) — this fires on service-side processing failure.
        if (db !== undefined) {
          void updateOutcome(db, deliveryId, "failed_at_reviewer", {
            message,
            stage: "reviewer",
            stack,
          });
        }
        log.error("webhook_processing_failed", {
          event: "webhook_processing_failed",
          delivery_id: deliveryId,
          sha: headSha,
          pr: prNumber,
          owner,
          repo,
          stage: "reviewer",
          error: message,
        });
      })
      .finally(() => {
        inflight.delete(promise);
      });

    inflight.add(promise);
  }

  async function handlePullRequestEvent(
    payload: PullRequestPayload,
    deliveryId: string
  ): Promise<void> {
    const prNumber = payload.pull_request.number;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    if (payload.pull_request.draft) {
      log.info("skip_draft", {
        event: "skip_draft",
        delivery_id: deliveryId,
        pr: prNumber,
        owner,
        repo,
      });
      // Persist skip outcome for draft PRs.
      if (db !== undefined) {
        void updateOutcome(db, deliveryId, "skipped");
      }
      return;
    }

    await updateStatusCommentSafe(owner, repo, prNumber, buildPendingBody());

    startDetachedReview(
      owner,
      repo,
      prNumber,
      payload.pull_request.user.login,
      payload.pull_request.head.sha,
      deliveryId
    );
  }

  /**
   * Call the Minsky MCP to apply post-merge state sync for a task.
   *
   * First looks up the session by taskId, then calls
   * session.apply_post_merge_state_sync with the session ID.
   * Errors are non-fatal — the merge-state sweeper will catch misses.
   */
  async function runMergeStateSyncViaTaskId(
    mcpUrl: string,
    mcpToken: string,
    taskId: string,
    mergeSha: string | undefined,
    mergedAt: string | undefined,
    deliveryId: string
  ): Promise<void> {
    // Look up session by taskId.
    const sessionLookupText = await callMcpToolLocal(mcpUrl, mcpToken, "session.get", {
      task: taskId,
    });

    if (!sessionLookupText) {
      log.warn("at_merge_handler.session_lookup_failed", {
        event: "at_merge_handler.session_lookup_failed",
        delivery_id: deliveryId,
        taskId,
        reason: "no_content",
      });
      return;
    }

    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(sessionLookupText) as {
        success?: boolean;
        session?: { sessionId?: string };
        sessionId?: string;
      };
      sessionId = parsed.session?.sessionId ?? parsed.sessionId ?? null;
    } catch {
      log.warn("at_merge_handler.session_lookup_parse_error", {
        event: "at_merge_handler.session_lookup_parse_error",
        delivery_id: deliveryId,
        taskId,
      });
      return;
    }

    if (!sessionId) {
      log.warn("at_merge_handler.session_not_found", {
        event: "at_merge_handler.session_not_found",
        delivery_id: deliveryId,
        taskId,
      });
      return;
    }

    // Call apply_post_merge_state_sync. The MCP command reads `params.sessionId`
    // (not `params.session`) — passing the wrong key throws ResourceNotFoundError
    // at runtime. PR #1010 R2 fix.
    const syncArgs: Record<string, unknown> = {
      sessionId,
      trigger: "webhook",
    };
    if (mergeSha) syncArgs["mergeSha"] = mergeSha;
    if (mergedAt) syncArgs["mergedAt"] = mergedAt;

    // PR #1121 R1 BLOCKING #1: spec requires fix-or-retry, not observability
    // alone. Retry the apply_post_merge_state_sync MCP call with bounded
    // backoff when it reports partial failure. The function is idempotent, so
    // retries are safe; success-path semantics are unchanged (no retry when
    // the first call succeeds). Max wall-clock ~13s (1+3+9), well under
    // Railway's webhook-response budget.
    //
    // The sweeper (mt#1752) still backstops within 10 min if all retries are
    // exhausted; the in-band retry covers the immediate window so the missed
    // sync doesn't accumulate operator-visible drift.
    const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
    const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const syncText = await callMcpToolLocal(
        mcpUrl,
        mcpToken,
        "session.apply_post_merge_state_sync",
        syncArgs
      );

      if (!syncText) {
        // Tool unavailable on every attempt would be the same outcome; no
        // point retrying. The sweeper picks this up.
        log.warn("at_merge_handler.sync_tool_unavailable", {
          event: "at_merge_handler.sync_tool_unavailable",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          attempt,
          message:
            "session.apply_post_merge_state_sync returned no content. " +
            "The merge-state sweeper will catch this.",
        });
        return;
      }

      // PR #1121 R1 BLOCKING #2: treat JSON parse failure as indeterminate, NOT
      // success. The handler's decision gate is sensitive to strict JSON; a
      // non-JSON response (or unexpected shape) must not silently emit
      // sync_complete.
      let parsedSync: Record<string, unknown> | null = null;
      try {
        parsedSync = JSON.parse(syncText) as Record<string, unknown>;
      } catch (parseErr) {
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        log.warn("at_merge_handler.sync_parse_error", {
          event: "at_merge_handler.sync_parse_error",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          attempt,
          error: errMsg,
          message:
            "apply_post_merge_state_sync returned non-JSON or malformed response. " +
            "Treating as indeterminate (not success). The merge-state sweeper will backstop.",
        });
        return;
      }

      // Extract partial-failure signals. Prefer the top-level `partialFailure`
      // boolean (PR #1121); fall back to the individual error fields when
      // older MCP responses don't yet include the boolean.
      const sessionUpdateError =
        typeof parsedSync.sessionUpdateError === "string"
          ? parsedSync.sessionUpdateError
          : undefined;
      const taskUpdateError =
        typeof parsedSync.taskUpdateError === "string" ? parsedSync.taskUpdateError : undefined;
      const partialFailure =
        parsedSync.partialFailure === true ||
        sessionUpdateError !== undefined ||
        taskUpdateError !== undefined;

      // Also require an affirmative `success: true` for sync_complete — if the
      // response lacks the field entirely (e.g., a schema-drift response shape),
      // treat as indeterminate rather than implicit success.
      const success = parsedSync.success === true;

      if (!partialFailure && success) {
        log.info("at_merge_handler.sync_complete", {
          event: "at_merge_handler.sync_complete",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          mergeSha,
          mergedAt,
          attempt,
        });
        return;
      }

      // Partial failure or missing success affirmation. Retry if attempts remain.
      const attemptsRemaining = MAX_ATTEMPTS - 1 - attempt;
      if (attemptsRemaining > 0) {
        const delayMs = RETRY_DELAYS_MS[attempt] ?? 0;
        log.warn("at_merge_handler.sync_partial_failure_retry", {
          event: "at_merge_handler.sync_partial_failure_retry",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          mergeSha,
          mergedAt,
          attempt,
          attemptsRemaining,
          delayMs,
          sessionUpdateError,
          taskUpdateError,
          missingSuccess: !success,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // All attempts exhausted. The sweeper (mt#1752) still backstops.
      log.error("at_merge_handler.sync_retry_exhausted", {
        event: "at_merge_handler.sync_retry_exhausted",
        delivery_id: deliveryId,
        taskId,
        sessionId,
        mergeSha,
        mergedAt,
        attempts: MAX_ATTEMPTS,
        sessionUpdateError,
        taskUpdateError,
        missingSuccess: !success,
        message:
          "apply_post_merge_state_sync reported partial failure on every retry. " +
          "The merge-state sweeper will backstop on its next cycle (mt#1752).",
      });
      return;
    }
  }

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.synchronize", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.reopened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  /**
   * Handle issue_comment.created events for /review comment commands (mt#2127).
   *
   * When a collaborator comments `/review` on an open PR, trigger a fresh
   * review on the PR's current HEAD. The command must be the sole content
   * of the comment (or the first line, trimmed).
   *
   * Guards:
   * - Only fires on comments attached to a PR (issue.pull_request present).
   * - Only fires on open PRs (issue.state === "open").
   * - Only fires for COLLABORATOR / MEMBER / OWNER author_association.
   * - Fetches the PR via Octokit to get the current HEAD sha.
   */
  webhooks.on("issue_comment.created", async ({ id: deliveryId, payload }) => {
    const p = payload as Record<string, unknown>;
    const issue = p["issue"] as Record<string, unknown> | undefined;
    const comment = p["comment"] as Record<string, unknown> | undefined;
    const repository = p["repository"] as Record<string, unknown> | undefined;

    if (!issue || !comment || !repository) return;

    // Gate: must be a PR comment (GitHub sends issue_comment for both issues and PRs).
    if (!issue["pull_request"]) {
      return;
    }

    // Gate: PR must be open.
    if (issue["state"] !== "open") {
      log.info("comment_command.skip_not_open", {
        event: "comment_command.skip_not_open",
        delivery_id: deliveryId,
        pr: issue["number"] as number,
        state: issue["state"] as string,
      });
      return;
    }

    // Gate: comment body must match a known command.
    const commentBody = comment["body"] as string | undefined;
    if (!commentBody) return;
    const firstLine = commentBody.split("\n")[0] ?? "";
    const isReviewCmd = REVIEW_COMMAND_RE.test(firstLine);
    const isResolveCmd = RESOLVE_COMMAND_RE.test(firstLine);
    if (!isReviewCmd && !isResolveCmd) {
      return;
    }

    // Gate: author must be a collaborator.
    const authorAssociation = comment["author_association"] as string | undefined;
    const commentUser = comment["user"] as Record<string, unknown> | undefined;
    if (!authorAssociation || !ALLOWED_ASSOCIATIONS.has(authorAssociation)) {
      log.info("comment_command.skip_non_collaborator", {
        event: "comment_command.skip_non_collaborator",
        delivery_id: deliveryId,
        pr: issue["number"] as number,
        author: commentUser?.["login"] as string | undefined,
        association: authorAssociation,
      });
      return;
    }

    const repoOwner = (repository["owner"] as Record<string, unknown>)?.["login"] as string;
    const repoName = repository["name"] as string;
    const prNumber = issue["number"] as number;
    const issueUser = issue["user"] as Record<string, unknown> | undefined;

    const commandName = isReviewCmd ? "review" : "resolve";
    const triggeredEvent = isReviewCmd
      ? "comment_command.review_triggered"
      : "comment_command.resolve_triggered";
    log.info(triggeredEvent, {
      event: triggeredEvent,
      command: commandName,
      delivery_id: deliveryId,
      pr: prNumber,
      owner: repoOwner,
      repo: repoName,
      triggeredBy: commentUser?.["login"] as string | undefined,
    });

    try {
      const octokit = await createOctokit(cfg);
      const { data: pr } = await octokit.pulls.get({
        owner: repoOwner,
        repo: repoName,
        pull_number: prNumber,
      });

      if (pr.draft) {
        log.info("comment_command.skip_draft", {
          event: "comment_command.skip_draft",
          command: commandName,
          delivery_id: deliveryId,
          pr: prNumber,
          owner: repoOwner,
          repo: repoName,
        });
        return;
      }

      if (isResolveCmd) {
        await handleResolveCommand(octokit, repoOwner, repoName, prNumber, deliveryId);
        return;
      }

      await updateStatusCommentSafe(repoOwner, repoName, prNumber, buildPendingBody());

      startDetachedReview(
        repoOwner,
        repoName,
        prNumber,
        pr.user?.login ?? (issueUser?.["login"] as string) ?? "unknown",
        pr.head.sha,
        deliveryId
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("comment_command.pr_fetch_failed", {
        event: "comment_command.pr_fetch_failed",
        command: commandName,
        delivery_id: deliveryId,
        pr: prNumber,
        owner: repoOwner,
        repo: repoName,
        error: message,
      });
    }
  });

  /**
   * Handle pull_request.closed events for at-merge state sync (mt#1614).
   *
   * @octokit/webhooks already validated the HMAC-SHA-256 signature before
   * dispatching here, so the payload is authenticated.
   *
   * Gate: only fire when pull_request.merged === true (closed-and-merged).
   * A PR closed without merge (e.g., rejected) does not trigger state sync.
   *
   * Implementation: call the Minsky MCP session.apply_post_merge_state_sync
   * tool via the same HTTP pattern as the PR-watch and Asks-reconcile schedulers.
   * The MCP server owns the domain logic; this handler is a thin trigger layer.
   *
   * Task-lookup path: head branch `task/mt-N` → taskId → sessionId via Minsky
   * MCP session.getByTaskId. If head branch doesn't match the task-branch
   * pattern, we log and return without error (may be a non-Minsky PR).
   *
   * TOCTOU analysis (§7b):
   * - Read atomicity: the payload carries merged=true already when we read it.
   *   The @octokit/webhooks library reads the body atomically before dispatch.
   *   Accept — single read, no interleaving.
   * - Decision-action gap: between receiving merged=true and calling
   *   apply_post_merge_state_sync, the session could theoretically already be
   *   synced (e.g., session_pr_merge ran). Accept — applyPostMergeStateSync is
   *   idempotent; calling it when already MERGED is a no-op.
   * - Stale-read: the payload is freshly delivered from GitHub.
   *   Accept — GitHub webhook delivery is the authoritative push event.
   */
  webhooks.on("pull_request.closed", async ({ id: deliveryId, payload }) => {
    // Runtime guard: only process merged PRs. The type system can't enforce
    // pull_request.merged at the webhook dispatch layer, so we guard here.
    if (!isMergedClosedPayload(payload)) {
      // Closed without merge — not a state-sync trigger.
      log.info("at_merge_handler.skip_not_merged", {
        event: "at_merge_handler.skip_not_merged",
        delivery_id: deliveryId,
        pr: (payload as Record<string, unknown>)["pull_request"]
          ? ((payload as Record<string, unknown>)["pull_request"] as Record<string, unknown>)[
              "number"
            ]
          : null,
      });
      return;
    }

    const pr = payload.pull_request;
    const headRef = pr.head.ref;
    const mergeSha = pr.merge_commit_sha ?? undefined;
    const mergedAt = pr.merged_at ?? undefined;
    const prNumber = pr.number;

    // Attempt to extract taskId from the head branch name.
    const taskId = extractTaskIdFromBranch(headRef);

    log.info("at_merge_handler.received", {
      event: "at_merge_handler.received",
      delivery_id: deliveryId,
      pr: prNumber,
      headRef,
      taskId,
      mergeSha,
      mergedAt,
    });

    if (!taskId) {
      // Not a Minsky task branch — skip silently. Non-Minsky PRs are expected.
      log.info("at_merge_handler.skip_non_task_branch", {
        event: "at_merge_handler.skip_non_task_branch",
        delivery_id: deliveryId,
        pr: prNumber,
        headRef,
      });
      return;
    }

    // Call applyPostMergeStateSync via Minsky MCP (fire-and-forget, detached).
    // The MCP path keeps the domain logic in Minsky core, not the reviewer service.
    if (!cfg.mcpUrl || !cfg.mcpToken) {
      log.warn("at_merge_handler.mcp_not_configured", {
        event: "at_merge_handler.mcp_not_configured",
        delivery_id: deliveryId,
        pr: prNumber,
        taskId,
        message:
          "MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN not set — cannot call apply_post_merge_state_sync. " +
          "The merge-state sweeper will catch this when it next runs.",
      });
      return;
    }

    const syncPromise: Promise<void> = runMergeStateSyncViaTaskId(
      cfg.mcpUrl,
      cfg.mcpToken,
      taskId,
      mergeSha,
      mergedAt,
      deliveryId
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("at_merge_handler.sync_error", {
        event: "at_merge_handler.sync_error",
        delivery_id: deliveryId,
        pr: prNumber,
        taskId,
        error: message,
      });
    });

    inflight.add(syncPromise);
    syncPromise.finally(() => inflight.delete(syncPromise));
  });

  const server = Bun.serve({
    port: cfg.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            provider: cfg.provider,
            model: cfg.providerModel,
            tier2Enabled: cfg.tier2Enabled,
            inflightCount: inflight.size,
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      // POST /retrigger — programmatic review retrigger (mt#2127 SC#5).
      // Accepts { pr: number, owner: string, repo: string } and triggers a
      // review on the PR's current HEAD.
      //
      // mt#2346: authenticated with the Minsky MCP auth token (cfg.mcpToken,
      // from MINSKY_MCP_AUTH_TOKEN) — the operator->service credential the
      // operator already holds and the reviewer service already has — NOT the
      // webhook HMAC secret. The webhook secret stays GitHub->reviewer signature
      // verification only (see the Webhooks handler above), so on-demand
      // triggering never requires spreading the signing secret to operators.
      if (request.method === "POST" && url.pathname === "/retrigger") {
        // Fail closed when the MCP auth token isn't configured on the service,
        // rather than silently falling back to the webhook secret. The caller
        // gets a generic message (don't leak the internal env-var name to an
        // unauthenticated caller); the specific cause is logged server-side so
        // an operator can diagnose it in headless runs.
        if (!cfg.mcpToken) {
          log.error("retrigger.auth_not_configured", {
            event: "retrigger.auth_not_configured",
            message:
              "POST /retrigger received but MINSKY_MCP_AUTH_TOKEN is unset on the reviewer " +
              "service; retrigger auth is unavailable until it is configured.",
          });
          return new Response(JSON.stringify({ error: "retrigger auth not configured" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        const authHeader = request.headers.get("authorization");
        const expectedToken = `Bearer ${cfg.mcpToken}`;
        if (authHeader !== expectedToken) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        let body: { pr?: number; owner?: string; repo?: string };
        try {
          body = (await request.json()) as { pr?: number; owner?: string; repo?: string };
        } catch {
          return new Response(JSON.stringify({ error: "invalid json" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        if (typeof body.pr !== "number" || body.pr < 1) {
          return new Response(JSON.stringify({ error: "missing or invalid 'pr' field" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        if (typeof body.owner !== "string" || !body.owner) {
          return new Response(JSON.stringify({ error: "missing or invalid 'owner' field" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        if (typeof body.repo !== "string" || !body.repo) {
          return new Response(JSON.stringify({ error: "missing or invalid 'repo' field" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const prNumber = body.pr;
        const owner = body.owner;
        const repo = body.repo;
        const deliveryId = `retrigger-${crypto.randomUUID()}`;

        try {
          const octokit = await createOctokit(cfg);
          const { data: pr } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: prNumber,
          });

          if (pr.state !== "open") {
            return new Response(JSON.stringify({ error: "PR is not open", state: pr.state }), {
              status: 422,
              headers: { "content-type": "application/json" },
            });
          }

          if (pr.draft) {
            return new Response(JSON.stringify({ error: "PR is a draft", pr: prNumber }), {
              status: 422,
              headers: { "content-type": "application/json" },
            });
          }

          await updateStatusCommentSafe(owner, repo, prNumber, buildPendingBody());

          startDetachedReview(
            owner,
            repo,
            prNumber,
            pr.user?.login ?? "unknown",
            pr.head.sha,
            deliveryId
          );

          return new Response(JSON.stringify({ ok: true, pr: prNumber, deliveryId }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("retrigger.error", {
            event: "retrigger.error",
            pr: prNumber,
            error: message,
          });
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // POST /alert-test — on-demand test send through the DEPLOYED alert sink
      // (mt#2451). Proves the production env-config → sink → Telegram → operator
      // path without waiting for a real circuit-breaker trip. Same bearer auth
      // as /retrigger (cfg.mcpToken, from MINSKY_MCP_AUTH_TOKEN).
      if (request.method === "POST" && url.pathname === "/alert-test") {
        // Fail closed when the MCP auth token isn't configured (mirror /retrigger).
        if (!cfg.mcpToken) {
          log.error("alert_test.auth_not_configured", {
            event: "alert_test.auth_not_configured",
            message:
              "POST /alert-test received but MINSKY_MCP_AUTH_TOKEN is unset on the reviewer " +
              "service; alert-test auth is unavailable until it is configured.",
          });
          return new Response(JSON.stringify({ error: "alert-test auth not configured" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        const authHeader = request.headers.get("authorization");
        if (authHeader !== `Bearer ${cfg.mcpToken}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        // Resolve the sink: prefer the shared instance passed from server start
        // (the SAME instance the sweeper uses); otherwise build from env. The
        // reported type comes from env config so it's accurate in production.
        const sinkConfig = loadAlertSinkConfig();
        const sink = alertSink !== undefined ? alertSink : buildAlertSink(sinkConfig);
        if (!sink) {
          return new Response(
            JSON.stringify({
              error: "no alert sink configured",
              hint:
                "Set ALERT_SINK_TYPE=telegram|webhook (and the corresponding " +
                "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or ALERT_SINK_URL) on the reviewer service.",
            }),
            { status: 503, headers: { "content-type": "application/json" } }
          );
        }

        // Sinks are CONTRACTED fail-open: notify() catches internally and
        // resolves (a delivery failure does NOT throw — it's swallowed, so a
        // 200 below means "accepted by the sink path; confirm receipt on the
        // phone"). A throw here is a contract violation (a buggy/future sink).
        // Defense-in-depth for a confidence probe: never let that 500 the
        // route. Log it (the reviewer logger redacts secrets) and return a 503
        // with a GENERIC body — do not echo the raw error to the caller, which
        // could carry credentials (mt#2463 redaction lesson).
        try {
          await sink.notify(
            "info",
            "Minsky reviewer alert test",
            "Minsky reviewer alert test — triggered via /alert-test. " +
              "If you received this, the deployed env-config → sink → operator alert path is healthy."
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("alert_test.sink_error", {
            event: "alert_test.sink_error",
            sinkType: sinkConfig.type,
            error: message,
          });
          return new Response(
            JSON.stringify({ error: "alert sink threw during send", sinkType: sinkConfig.type }),
            { status: 503, headers: { "content-type": "application/json" } }
          );
        }
        log.info("alert_test.sent", {
          event: "alert_test.sent",
          sinkType: sinkConfig.type,
        });
        return new Response(
          JSON.stringify({ ok: true, sinkType: sinkConfig.type, deliveryAttempted: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const signature = request.headers.get("x-hub-signature-256");
        // R2 BLOCKING fix: previously fell back to the literal "unknown".
        // Combined with DO NOTHING upsert semantics, that collapsed every
        // missing-header POST into a single row — silently dropping events
        // after the first. Synthesize a UUID per request instead. The
        // "synthetic-" prefix is queryable so operators can distinguish
        // GitHub-supplied IDs from server-synthesized ones.
        const deliveryId =
          request.headers.get("x-github-delivery") ?? `synthetic-${crypto.randomUUID()}`;
        const eventName = request.headers.get("x-github-event");

        // Read body BEFORE the missing-headers check so we can include `action`
        // in the webhook_received log. Body reads are cheap for legitimate
        // payloads; malicious-volume attacks are handled downstream by signature
        // verification rejecting invalid payloads.
        const body = await request.text();

        // Best-effort extract `action` from the JSON body for observability.
        // If the body is not valid JSON or has no `action` field, we emit null.
        let parsedBody: Record<string, unknown> | null = null;
        let action: string | null = null;
        try {
          parsedBody = JSON.parse(body) as Record<string, unknown>;
          if (typeof parsedBody["action"] === "string") {
            action = parsedBody["action"];
          }
        } catch {
          // Non-JSON or malformed body — action stays null, parsedBody stays null.
        }

        // Log webhook_received BEFORE the missing-headers check so that requests
        // with absent headers (signature_present: false) still produce a log line.
        // This is the primary diagnostic signal for bad-actor or misconfigured senders.
        log.info("webhook_received", {
          event: "webhook_received",
          delivery_id: deliveryId,
          github_event: eventName ?? null,
          action,
          signature_present: Boolean(signature),
        });

        // Persist webhook receipt for forensic investigation (mt#1372).
        // Fire-and-forget: recordWebhookReceipt swallows errors internally.
        //
        // R1 BLOCKING #3 fix: persist EVERY webhook the reviewer receives,
        // not just those with x-github-event header. Webhooks with missing
        // or malformed headers are exactly the cases most worth investigating
        // (misconfigured senders, GitHub API changes, malicious probes).
        // Use "unknown" sentinel when eventName is null.
        if (db !== undefined) {
          void recordWebhookReceipt(
            db,
            deliveryId,
            eventName ?? "unknown",
            extractPersistedHeaders((name) => request.headers.get(name)),
            parsedBody ?? { raw: safeTruncate(body, 1000, "head") }
          );
        }

        if (!signature || !eventName) {
          return new Response("missing signature or event headers", { status: 400 });
        }

        try {
          // verifyAndReceive validates the signature and dispatches to the
          // registered webhook handlers. The handlers call startDetachedReview
          // which returns immediately (fire-and-forget). So this await only
          // blocks for signature verification + event dispatch, not the review.
          await webhooks.verifyAndReceive({
            id: deliveryId,
            name: eventName,
            payload: body,
            signature,
          });
          return new Response("ok", { status: 200 });
        } catch (error) {
          // verifyAndReceive throws on signature-verification failure.
          // Handler errors no longer propagate here since reviews are detached.
          const message = error instanceof Error ? error.message : String(error);
          const isSignatureError = /signature/i.test(message);
          log.error(isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error", {
            event: isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error",
            delivery_id: deliveryId,
            deliveryId, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to delivery_id
            github_event: eventName,
            eventName, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to github_event
            error: message,
          });

          // Persist failure outcome and surface as operator-visible alert (mt#1372).
          // Signature failures are expected from misconfigured senders — only non-signature
          // errors (dispatch failures) surface as webhook_processing_failed alerts.
          if (db !== undefined) {
            void updateOutcome(
              db,
              deliveryId,
              isSignatureError ? "failed_at_signature" : "failed_at_tier_resolve",
              { message, stage: isSignatureError ? "signature" : "dispatch" }
            );
          }
          if (!isSignatureError) {
            // Dispatch errors are unexpected — alert the operator (Railway logs).
            log.error("webhook_processing_failed", {
              event: "webhook_processing_failed",
              delivery_id: deliveryId,
              github_event: eventName,
              stage: "dispatch",
              error: message,
            });
          }

          return new Response(isSignatureError ? "invalid signature" : "internal error", {
            status: isSignatureError ? 401 : 500,
          });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  /**
   * Graceful shutdown for this server instance.
   *
   * 1. Logs drain start with current inflight count.
   * 2. Stops accepting new connections.
   * 3. Waits for all in-flight reviews to settle (max 25s).
   * 4. Logs drain complete and sets exitCode = 0.
   */
  async function gracefulShutdown(): Promise<void> {
    log.info("shutdown_drain_start", {
      event: "shutdown_drain_start",
      inflightCount: inflight.size,
    });

    server.stop(true);

    const drain = Promise.allSettled(Array.from(inflight));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
    await Promise.race([drain, timeout]);

    log.info("shutdown_drain_complete", {
      event: "shutdown_drain_complete",
    });

    process.exitCode = 0;
  }

  return { server, gracefulShutdown };
}

// ---------------------------------------------------------------------------
// Module-level startup (production entry point)
//
// Guarded by import.meta.main so this file can be imported in tests without
// triggering loadConfig() (which requires real env vars) or starting a server
// on the production port.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = loadConfig();

  // Apply reviewer migrations before starting the server.
  // Fail-fast: if migrations error, log and exit non-zero.
  let db;
  try {
    db = getDb();
    await applyMigrations(db);
    log.info("migrations_applied", { event: "migrations_applied" });
  } catch (err: unknown) {
    log.error("migration_error", {
      event: "migration_error",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Boot the domain container (mt#2121). Provides TaskService and
  // PersistenceProvider for direct domain imports in background loops and
  // per-review operations (task-spec fetch, tier resolution). Non-fatal:
  // if the domain container fails to boot (e.g., DB unreachable), the
  // service starts without domain services and falls back gracefully.
  let domainServices: DomainServices | undefined;
  try {
    domainServices = await bootDomainContainer();
    log.info("domain_container_booted", { event: "domain_container_booted" });
  } catch (err: unknown) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    log.warn("domain_container_boot_failed", {
      event: "domain_container_boot_failed",
      error: errorDetail,
      message:
        "Domain services unavailable — task-spec fetch and tier resolution will degrade gracefully.",
    });
    // mt#2450 surfacing: this failure silently disables the pr-watch
    // scheduler, merge-state sweeper, tier resolution, AND the
    // circuit-breaker→Ask path (mt#2363) — it went unnoticed in production
    // behind the warn line above (the mt#1596 "logging ≠ surfacing" class).
    // Push it through the external alert sink so the operator is paged.
    // Fail-open: a sink failure must not affect boot.
    void Promise.resolve(
      buildAlertSink(loadAlertSinkConfig())?.notify(
        "error",
        "Reviewer domain container failed to boot",
        `bootDomainContainer() threw at startup: ${errorDetail}. ` +
          "Degraded: no pr-watch scheduler, no merge-state sweeper, no tier " +
          "resolution, no circuit-breaker Asks. See mt#2450."
      )
    ).catch(() => {});
  }

  // mt#2451: build the external alert sink ONCE at server start and share the
  // single instance with both createApp (the /alert-test route) and startSweeper.
  // Null when ALERT_SINK_TYPE is unset/off; both consumers degrade gracefully.
  const alertSink = buildAlertSink(loadAlertSinkConfig());

  const { server, gracefulShutdown } = createApp(config, runReview, db, domainServices, alertSink);

  log.info("server_started", {
    event: "server_started",
    port: server.port,
    provider: config.provider,
    model: config.providerModel,
    tier2Enabled: config.tier2Enabled,
    domainServicesEnabled: Boolean(domainServices),
  });

  // Register graceful shutdown handlers for SIGTERM, SIGINT, SIGHUP.
  // On signal: emit shutdown_signal log line (mt#1966 SC#3) so future
  // restart-cause investigations can see WHICH signal triggered the shutdown,
  // then stop accepting new connections, drain in-flight reviews (max 25s), then exit.
  //
  // The shutdown_signal log line was the load-bearing observability gap during
  // mt#1963 — the 2026-05-20 restart window showed no signal in retained logs,
  // making the restart cause invisible. Adding the log on signal arrival closes
  // that gap for future incidents.
  function handleShutdownSignal(signal: "SIGTERM" | "SIGINT" | "SIGHUP"): void {
    const uptimeSec = process.uptime();
    log.warn("shutdown_signal", {
      event: "shutdown_signal",
      signal,
      uptime_sec: Math.round(uptimeSec * 1000) / 1000,
    });
    gracefulShutdown().catch((err: unknown) => {
      log.error("shutdown_error", {
        event: "shutdown_error",
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    });
  }
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGHUP", () => handleShutdownSignal("SIGHUP"));

  // Uncaught-exception and unhandled-rejection handlers (mt#1966 SC#3).
  // These fire on bugs the normal try/catch chain doesn't reach. Without
  // these, a crash exits silently with no log line — the 2026-05-20 mt#1963
  // window suggested either a silent crash or a Railway-side signal; we
  // couldn't tell because neither path emitted a log. The handlers below
  // make BOTH paths observable. The handlers do not attempt graceful
  // shutdown — by the time they fire the process state is undefined and
  // the right move is fail-fast with diagnostics in the log.
  process.on("uncaughtException", (err: Error) => {
    log.error("uncaught_exception", {
      event: "uncaught_exception",
      uptime_sec: Math.round(process.uptime() * 1000) / 1000,
      error: err.message,
      stack: err.stack?.slice(0, 1000),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error("unhandled_rejection", {
      event: "unhandled_rejection",
      uptime_sec: Math.round(process.uptime() * 1000) / 1000,
      error: err.message,
      stack: err.stack?.slice(0, 1000),
    });
    process.exit(1);
  });

  // Start the periodic sweeper safety net (mt#1260).
  // In-process setInterval chosen over Railway cron for simplicity: no separate
  // entry-point, shares the same config/auth already loaded above.
  // Configurable via SWEEPER_ENABLED, SWEEPER_INTERVAL_MS, SWEEPER_REPO_OWNER,
  // SWEEPER_REPO_NAME. Opt-in: sweeper is DISABLED by default; set
  // SWEEPER_ENABLED=true to activate. When disabled, logs event: "sweeper.disabled".
  // mt#2363 / mt#1596 Phase 1: the domain container is forwarded so a tripped
  // circuit breaker also surfaces as an operator-routed Ask on the cockpit
  // (direct domain imports, mt#2121 — no MCP-over-HTTP).
  // mt#2660: startSweeper also KICKS OFF one boot catch-up sweep cycle
  // synchronously at this call site (the sweep work itself completes
  // asynchronously afterward, via the same non-blocking runReview path the
  // periodic ticks use), so a redeploy landing on top of an unreviewed PR
  // self-heals without waiting a full SWEEPER_INTERVAL_MS. Gated by
  // SWEEPER_BOOT_CATCHUP_ENABLED (default true); called here — after
  // migrations have applied and the domain-container boot ATTEMPT above has
  // resolved (success or graceful degradation; `domainServices` may still be
  // `undefined`) — so it never blocks startup either way. See sweeper.ts
  // module-header "Boot catch-up sweep" for the diagnosis of why the
  // pre-mt#2660 sweeper missed PR #1812's webhook for 25+ minutes.
  startSweeper(config, loadSweeperConfig(), db, domainServices?.container, alertSink);

  // Start the PR-watch scheduler (mt#1618 / mt#1899).
  // Uses domain imports (mt#2121) via the booted domain container — no MCP-over-HTTP.
  // Configurable via PR_WATCH_ENABLED, PR_WATCH_POLL_INTERVAL_MS.
  // Enabled by default post-mt#1899; set PR_WATCH_ENABLED=false to disable.
  startPrWatchScheduler(config, loadPrWatchSchedulerConfig(), domainServices?.container);

  // Start the Asks-reconcile scheduler (mt#1636).
  // Uses domain imports (mt#2121) via the booted domain container — no MCP-over-HTTP.
  // Configurable via ASKS_RECONCILE_ENABLED, ASKS_RECONCILE_POLL_INTERVAL_MS.
  // Opt-in: disabled by default; set ASKS_RECONCILE_ENABLED=true to activate.
  startAsksReconcileScheduler(
    config,
    loadAsksReconcileSchedulerConfig(),
    domainServices?.container
  );

  // Start the merge-state sweeper backstop (mt#1614).
  // Uses domain imports (mt#2121) via SessionProviderInterface + applyPostMergeStateSync.
  // Configurable via MERGE_STATE_SWEEPER_ENABLED, MERGE_STATE_SWEEPER_INTERVAL_MS.
  // **Enabled by default (mt#1811)**: set MERGE_STATE_SWEEPER_ENABLED=false to opt out.
  startMergeStateSweeper(
    config,
    loadMergeStateSweeperConfig(),
    domainServices
      ? {
          sessionProvider: domainServices.sessionProvider,
          taskService: domainServices.taskService,
        }
      : undefined
  );

  // Start the adoption sweeper (mt#1630).
  // Post-merge adoption verification: picks up recently-DONE tasks, extracts
  // adoption signals from specs, greps production callsites, and files
  // mt#X-adoption follow-up tasks for gaps.
  // Configurable via ADOPTION_SWEEPER_ENABLED, ADOPTION_SWEEPER_INTERVAL_MS,
  // ADOPTION_SWEEPER_LOOKBACK_DAYS.
  // Requires MINSKY_MCP_URL + MINSKY_MCP_AUTH_TOKEN to be set.
  // Disabled by default; set ADOPTION_SWEEPER_ENABLED=true to activate.
  startAdoptionSweeper(config, loadAdoptionSweeperConfig());

  // Start the webhook-event retention pruner (mt#1372).
  // Deletes reviewer_webhook_events rows older than MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS
  // (default: 90 days). Runs once every 24 hours. The first prune fires after
  // the first interval to avoid competing with service startup.
  // Configurable via MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS (default: 90).
  // Strict-positive parse (mt#1811 cascade-defense): NaN flowing into
  // pruneOldRows would yield unpredictable retention behavior.
  const webhookRetentionDays = parsePositiveIntEnv(
    "MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS",
    90
  );
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  log.info("webhook_retention_pruner_started", {
    event: "webhook_retention_pruner_started",
    retention_days: webhookRetentionDays,
    interval_ms: PRUNE_INTERVAL_MS,
  });
  setInterval(() => {
    pruneOldRows(db, webhookRetentionDays).catch((err: unknown) => {
      log.error("webhook_retention_prune_error", {
        event: "webhook_retention_prune_error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, PRUNE_INTERVAL_MS);

  if (config.provider === "anthropic") {
    log.warn("degraded_config_warning", {
      event: "degraded_config_warning",
      message:
        "REVIEWER_PROVIDER=anthropic: implementer and reviewer likely share the Claude model family. Chinese wall captures context-isolation benefit only, not architectural diversity. Consider openai or google for full Sprint A coverage. See services/reviewer/README.md.",
    });
  }
}
