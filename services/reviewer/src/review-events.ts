/**
 * `pr.review_posted` system-event emission for the reviewer (mt#2725).
 *
 * The reviewer does NOT own the `system_events` table (it's a Minsky-domain
 * table), so — like the adoption sweeper's `task.auto_created` emit — this goes
 * through the hosted Minsky MCP `events_emit` tool via the shared `callMcp`
 * client, not a direct DB write.
 *
 * Best-effort: never throws, never blocks the review. When the MCP connection
 * is unconfigured (local/test), the emit is silently skipped.
 */

import type { ReviewerConfig } from "./config";
import { callMcp } from "./mcp-client";
import { log } from "./logger";

/** The GitHub review submit-event, as computed by the review paths. */
export type ReviewSubmitEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Input for a `pr.review_posted` emit. Owner/repo/prNumber locate the PR;
 * `event` is the submit action (mapped to a GitHub review STATE below);
 * `reviewerLogin` is the posting App identity; `taskId` is the resolved
 * Minsky task id when the PR maps to one.
 */
export interface ReviewPostedEvent {
  owner: string;
  repo: string;
  prNumber: number;
  reviewerLogin: string;
  event: ReviewSubmitEvent;
  taskId?: string;
}

/**
 * Map the submit EVENT (APPROVE / REQUEST_CHANGES / COMMENT) to the GitHub
 * review STATE the cockpit consumer reads (`plant-gestures.ts` branches on
 * `payload.state === "CHANGES_REQUESTED"` vs. else). These are GitHub's
 * PullRequestReview.state values (past tense), distinct from the submit event.
 */
const EVENT_TO_STATE: Record<ReviewSubmitEvent, "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

/**
 * Timeout for the emit's MCP round-trip. This emit is awaited on the review's
 * critical path, so it is bounded well below callMcp's 15s default to cap the
 * added tail latency when the hosted MCP is slow/unavailable — the emit is
 * best-effort observability, so dropping it under a slow MCP is the right
 * trade against stalling review completion. A healthy initialize + tools/call
 * round-trip is well under this bound.
 */
const EMIT_TIMEOUT_MS = 5_000;

/**
 * Emit a `pr.review_posted` system event via the hosted Minsky MCP.
 *
 * Payload matches the documented shape in
 * `packages/domain/src/storage/schemas/system-events-schema.ts`:
 * `{ prUrl, prNumber, reviewer, state, taskId? }`.
 *
 * Best-effort: skips silently when MCP is unconfigured, logs (but never throws)
 * on any transport/tool failure.
 */
export async function emitReviewPostedEvent(
  config: ReviewerConfig,
  ev: ReviewPostedEvent,
  callMcpFn: typeof callMcp = callMcp
): Promise<void> {
  const mcpUrl = config.mcpUrl;
  const mcpToken = config.mcpToken;
  // MCP not configured (local dev / tests): skip silently — the emit is
  // best-effort observability, not part of the review contract.
  if (!mcpUrl || !mcpToken) return;

  const prUrl = `https://github.com/${ev.owner}/${ev.repo}/pull/${ev.prNumber}`;
  const payload: Record<string, unknown> = {
    prUrl,
    prNumber: ev.prNumber,
    reviewer: ev.reviewerLogin,
    state: EVENT_TO_STATE[ev.event],
  };
  if (ev.taskId) payload.taskId = ev.taskId;

  try {
    const result = await callMcpFn(
      "events_emit",
      {
        eventType: "pr.review_posted",
        payload,
        actor: ev.reviewerLogin,
        ...(ev.taskId ? { relatedTaskId: ev.taskId } : {}),
      },
      { mcpUrl, mcpToken },
      { logPrefix: "reviewer.review_posted_event", timeoutMs: EMIT_TIMEOUT_MS }
    );
    if (!result.ok) {
      log.warn("reviewer.review_posted_event_failed", {
        event: "reviewer.review_posted_event_failed",
        prUrl,
        reason: result.reason,
        message: result.message,
      });
    }
  } catch (err: unknown) {
    // callMcp is not expected to throw (it returns a CallMcpFailure), but guard
    // defensively so a review is never failed by an event-emit error.
    log.warn("reviewer.review_posted_event_error", {
      event: "reviewer.review_posted_event_error",
      prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
