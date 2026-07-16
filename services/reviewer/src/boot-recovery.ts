/**
 * Boot-time recovery for reviews interrupted by a container restart/redeploy
 * (mt#2799 Layer 2 — re-escalation of mt#1966's deferred durable-queue half,
 * per bridge memory 22dd1b42's preserved implementation pattern).
 *
 * ## Design
 *
 * The primary /webhook path (server.ts) now AWAITS `recordWebhookReceipt`
 * before returning the 200 ACK, so every `pull_request` webhook the reviewer
 * receives has a durable `reviewer_webhook_events` row on disk before GitHub
 * gets its response. That row's `outcome` column tracks how far processing
 * got: `received` (webhook persisted, review not yet dispatched) or
 * `reviewer_called` (review dispatched, not yet resolved) are BOTH
 * non-terminal — a row still in either state some time after receipt means
 * the process that was handling it died before reaching a terminal outcome
 * (`review_submitted` / `skipped` / `failed_at_*`).
 *
 * This module queries for exactly those rows at boot and re-dispatches each
 * through the SAME `runReview` path the webhook handler uses, tagged with a
 * `recovered-<originalDeliveryId>` delivery id (mirrors the sweeper's
 * `sweeper-<timestamp>` tagging — see review-worker.ts's `acquiredBy`
 * classification).
 *
 * ## Why no new table / no new `outcome` enum value
 *
 * The bridge memory's preserved pattern names `reviewer_webhook_events` with
 * `outcome=pending` as one option. This implementation reuses the EXISTING
 * `received` / `reviewer_called` non-terminal states instead of adding a new
 * enum value: a row that is still non-terminal well after receipt already
 * IS "pending recovery" — no new column or value is needed to express that,
 * and skipping a migration removes a whole class of migration/rollout risk
 * for what is otherwise a query-shape decision. See mt#2799 spec for the
 * explicit decision record.
 *
 * ## Coordination with the mt#1907 in-flight marker (no new dedup)
 *
 * `runReview` (review-worker.ts) already acquires the `reviewer_inflight_reviews`
 * marker for (owner, repo, prNumber, headSha) BEFORE doing any real work, and
 * returns `{ status: "skipped", reason: "concurrent_inflight" }` when another
 * process already holds it. During Railway's overlap window the OLD process
 * may still be genuinely mid-review when the NEW process boots and runs this
 * recovery pass — in that case runReview's existing marker check is what
 * prevents a duplicate review, and this module does NOT touch the
 * `reviewer_webhook_events` row's outcome in that specific case (the row
 * belongs to whichever process actually finishes the review; overwriting it
 * here would just get clobbered by that process's own `updateOutcome` call
 * moments later, but skipping it entirely is cleaner and avoids the
 * transient-inconsistent-state window). Per the bridge memory's explicit
 * instruction: "existing inflight-marker check is sufficient... do NOT build
 * new dedup" — this module adds none.
 *
 * ## Scope
 *
 * Recovery covers `pull_request` webhook events only (opened / synchronize /
 * reopened — the events `handlePullRequestEvent` in server.ts dispatches to
 * `startDetachedReview`). `issue_comment` (/review, /resolve) command
 * recovery is out of scope for mt#2799 (see its spec's Scope section) —
 * those commands are operator-triggered and re-issuing them is cheap; the
 * durability gap this task closes is specifically "a GitHub-delivered PR
 * event's review vanishes on redeploy," which is the primary/automatic path.
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import type { ReviewerDb } from "./db/client";
import {
  webhookEventsTable,
  type WebhookEventRecord,
  type WebhookOutcome,
} from "./db/schemas/webhook-events-schema";
import { updateOutcome, extractPgErrorContext } from "./webhook-events";
import { runReview, type RunReviewDeps, type ReviewResult } from "./review-worker";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Non-terminal outcomes eligible for boot-time recovery. */
const RECOVERABLE_OUTCOMES: WebhookOutcome[] = ["received", "reviewer_called"];

/** Default maximum age of a row eligible for recovery (30 minutes). */
const DEFAULT_MAX_AGE_MS = 30 * 60_000;

/** Default maximum number of rows recovered per boot (bounds a pathological backlog). */
const DEFAULT_MAX_ROWS = 20;

export interface BootRecoveryConfig {
  /** Whether boot recovery runs at all. Default true. */
  enabled: boolean;
  /** Rows older than this are left alone (likely a stuck/unrelated bug, not a normal recovery case). */
  maxAgeMs: number;
  /** Upper bound on rows recovered in a single boot pass. */
  maxRows: number;
}

/**
 * Load boot-recovery configuration from the environment. Mirrors the
 * load*Config() pattern used by the sweeper / pr-watch-scheduler /
 * asks-reconcile-scheduler — a dedicated loader rather than fields on
 * ReviewerConfig, since this is an operational on/off + tuning knob, not
 * core reviewer config threaded through every module.
 */
export function loadBootRecoveryConfig(): BootRecoveryConfig {
  const enabledRaw = process.env["REVIEWER_BOOT_RECOVERY_ENABLED"];
  const enabled = enabledRaw === undefined ? true : enabledRaw !== "false";
  return {
    enabled,
    maxAgeMs: parsePositiveIntEnv("REVIEWER_BOOT_RECOVERY_MAX_AGE_MS", DEFAULT_MAX_AGE_MS),
    maxRows: parsePositiveIntEnv("REVIEWER_BOOT_RECOVERY_MAX_ROWS", DEFAULT_MAX_ROWS),
  };
}

// ---------------------------------------------------------------------------
// Row → recovery-target extraction
// ---------------------------------------------------------------------------

/** Minimal shape read out of a persisted pull_request webhook body. */
interface RecoverablePullRequestBody {
  pull_request?: {
    number?: unknown;
    user?: { login?: unknown };
    head?: { sha?: unknown };
  };
  repository?: { owner?: { login?: unknown }; name?: unknown };
}

export interface RecoveryTarget {
  owner: string;
  repo: string;
  prNumber: number;
  prAuthorLogin: string;
  headSha: string;
}

/**
 * Extract enough context from a persisted webhook row's body to re-dispatch
 * a review. Returns null when the body doesn't have the required shape
 * (defensive — the body is untrusted JSONB from a prior process; malformed
 * or unexpected shapes must not throw, per the trust-boundary discipline).
 */
export function extractRecoveryTarget(row: WebhookEventRecord): RecoveryTarget | null {
  const body = row.body as RecoverablePullRequestBody | null;
  const pr = body?.pull_request;
  const repository = body?.repository;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const prNumber = pr?.number;
  const headSha = pr?.head?.sha;
  const prAuthorLogin = pr?.user?.login;

  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof prNumber !== "number" ||
    typeof headSha !== "string" ||
    !headSha
  ) {
    return null;
  }

  return {
    owner,
    repo,
    prNumber,
    headSha,
    prAuthorLogin: typeof prAuthorLogin === "string" && prAuthorLogin ? prAuthorLogin : "unknown",
  };
}

// ---------------------------------------------------------------------------
// Recovery pass
// ---------------------------------------------------------------------------

export interface BootRecoveryResult {
  /** Rows found eligible for recovery (non-terminal, pull_request, within maxAgeMs). */
  candidates: number;
  /** Rows successfully dispatched through runReviewFn. */
  dispatched: number;
  /** Candidate rows whose body could not be parsed into a recovery target. */
  malformed: number;
}

/** Injectable runReview function type, matching sweeper.ts's own local alias. */
export type RunReviewFn = typeof runReview;

/**
 * Query for interrupted `pull_request` reviews and re-dispatch each through
 * the standard runReview path. Returns once every eligible row has been
 * DISPATCHED (not once the reviews themselves have completed) — dispatch is
 * synchronous with respect to this function's return; the reviews
 * themselves run detached, matching startDetachedReview's fire-and-forget
 * shape in server.ts. Callers (server.ts boot sequence) must not await
 * review completion before proceeding — only dispatch, per mt#2799 AT#3
 * ("service boot dispatches the review within 30s").
 */
export async function recoverPendingReviews(
  db: ReviewerDb,
  config: ReviewerConfig,
  recoveryCfg: BootRecoveryConfig,
  runReviewFn: RunReviewFn = runReview,
  deps: RunReviewDeps = {}
): Promise<BootRecoveryResult> {
  if (!recoveryCfg.enabled) {
    log.info("boot_recovery.disabled", { event: "boot_recovery.disabled" });
    return { candidates: 0, dispatched: 0, malformed: 0 };
  }

  const cutoff = new Date(Date.now() - recoveryCfg.maxAgeMs);

  let rows: WebhookEventRecord[];
  try {
    rows = await db
      .select()
      .from(webhookEventsTable)
      .where(
        and(
          inArray(webhookEventsTable.outcome, RECOVERABLE_OUTCOMES),
          eq(webhookEventsTable.eventType, "pull_request"),
          gt(webhookEventsTable.receivedAt, cutoff)
        )
      )
      .limit(recoveryCfg.maxRows);
  } catch (err: unknown) {
    log.error("boot_recovery.query_failed", {
      event: "boot_recovery.query_failed",
      ...extractPgErrorContext(err),
    });
    return { candidates: 0, dispatched: 0, malformed: 0 };
  }

  if (rows.length === 0) {
    log.info("boot_recovery.none_found", { event: "boot_recovery.none_found" });
    return { candidates: 0, dispatched: 0, malformed: 0 };
  }

  let dispatched = 0;
  let malformed = 0;

  for (const row of rows) {
    const target = extractRecoveryTarget(row);
    if (!target) {
      malformed++;
      log.warn("boot_recovery.malformed_row", {
        event: "boot_recovery.malformed_row",
        delivery_id: row.deliveryId,
        outcome: row.outcome,
      });
      continue;
    }

    const recoveredDeliveryId = `recovered-${row.deliveryId}`;

    log.info("boot_recovery.dispatch", {
      event: "boot_recovery.dispatch",
      delivery_id: recoveredDeliveryId,
      original_delivery_id: row.deliveryId,
      owner: target.owner,
      repo: target.repo,
      pr: target.prNumber,
      head_sha: target.headSha,
      received_at: row.receivedAt.toISOString(),
      prior_outcome: row.outcome,
    });

    // Detached: dispatch and move on. Persist the eventual outcome back
    // onto the ORIGINAL row (row.deliveryId) so a subsequent boot doesn't
    // keep re-discovering it as a recovery candidate.
    void runReviewFn(
      config,
      target.owner,
      target.repo,
      target.prNumber,
      target.prAuthorLogin,
      recoveredDeliveryId,
      target.headSha,
      { ...deps, db }
    )
      .then((result: ReviewResult) => {
        log.info("boot_recovery.result", {
          event: "boot_recovery.result",
          delivery_id: recoveredDeliveryId,
          original_delivery_id: row.deliveryId,
          status: result.status,
          reason: result.reason,
        });

        // The OLD process may still legitimately hold the mt#1907 in-flight
        // marker if it hasn't finished draining yet (Railway overlap
        // window) — runReview's own marker check already returned this
        // skip; leave the row's outcome untouched so the process that
        // actually owns the review is the one that finalizes it. See this
        // file's header comment.
        if (result.status === "skipped" && result.reason === "concurrent_inflight") {
          log.info("boot_recovery.skip_concurrent_inflight", {
            event: "boot_recovery.skip_concurrent_inflight",
            delivery_id: recoveredDeliveryId,
            original_delivery_id: row.deliveryId,
          });
          return;
        }

        const outcome: WebhookOutcome =
          result.status === "reviewed"
            ? "review_submitted"
            : result.status === "skipped"
              ? "skipped"
              : "failed_at_reviewer";

        void updateOutcome(
          db,
          row.deliveryId,
          outcome,
          outcome === "failed_at_reviewer"
            ? {
                message: result.reason ?? "recovered review did not complete with status=reviewed",
                stage: "boot_recovery",
              }
            : undefined
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("boot_recovery.error", {
          event: "boot_recovery.error",
          delivery_id: recoveredDeliveryId,
          original_delivery_id: row.deliveryId,
          error: message,
        });
        void updateOutcome(db, row.deliveryId, "failed_at_reviewer", {
          message,
          stage: "boot_recovery",
        });
      });

    dispatched++;
  }

  log.info("boot_recovery.completed", {
    event: "boot_recovery.completed",
    candidates: rows.length,
    dispatched,
    malformed,
  });

  return { candidates: rows.length, dispatched, malformed };
}
