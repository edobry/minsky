/**
 * Wake-signal dispatch for the originating agent on quality.review Ask responses.
 *
 * When a quality.review Ask transitions to `responded` (via the reconciler), the
 * originating agent identified by `parentSessionId` should be signalled so it can
 * address the review. Without this hook, the loop terminates at the operator-notify
 * bell — review never reaches the agent that filed the Ask.
 *
 * The wake is parallel to the operator-notify path, NOT a replacement: bell + notify
 * still fire as before. This module only adds an additional signal-out for the
 * originating agent.
 *
 * Reference: mt#1481 spec.
 */

import { log } from "../../utils/logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Wake-signal payload emitted when a `quality.review` Ask transitions to
 * `responded`. Field set is exactly the seven fields specified in mt#1481 —
 * no extras. Adding fields requires a spec update so downstream consumers
 * know what to expect.
 */
export interface WakeSignalPayload {
  /** Primary key of the Ask that just responded. */
  askId: string;
  /** Session UUID of the agent that originally filed the Ask. */
  parentSessionId: string;
  /** Task ID associated with the parent session, when present. */
  parentTaskId?: string;
  /** Body of the GitHub review that triggered the response. */
  reviewBody: string;
  /** Verdict of the review (APPROVED, CHANGES_REQUESTED, etc.). */
  reviewState: string;
  /** Reviewer login (human or bot); null when GitHub did not return one. */
  reviewAuthor: string | null;
  /** Pull request number the review was posted on. */
  prNumber: number;
}

/**
 * Sink interface for wake signals.
 *
 * Implementations deliver the signal via whatever transport is live: a structured
 * log entry (default — `LoggingWakeSignalSink`), a session-liveness mark, mesh
 * push (mt#1001), AG-UI interrupt (mt#697), etc. This interface is the DI seam
 * tests use to spy on signal emission.
 */
export interface WakeSignalSink {
  /**
   * Deliver one wake signal. Errors propagate — the reconciler wraps the
   * dispatch in its own try/catch so a sink failure does not roll back the
   * already-recorded `respond()`.
   */
  emit(signal: WakeSignalPayload): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Default sink: structured log emission
// ---------------------------------------------------------------------------

/**
 * Default `WakeSignalSink` that writes the wake event to the structured logger.
 *
 * Per mt#1481's transport-availability analysis at the time of shipping:
 *   - mt#1001 (mesh push): not yet built — research-stage TODO
 *   - mt#697 (AG-UI interrupt): evaluation only, recommended NOT for mesh push
 *   - mt#1144 (cockpit shell): not yet built
 *
 * Log-only is the simplest live path: every operator running Minsky already
 * sees structured logs and can `tail` / filter on the `event=ask.wake` field.
 * When mt#1001 or mt#1144 lands, replace this default at composition time —
 * no other change required.
 */
export class LoggingWakeSignalSink implements WakeSignalSink {
  emit(signal: WakeSignalPayload): void {
    log.info("ask.wake", {
      event: "quality.review.responded",
      ...signal,
    });
  }
}

// ---------------------------------------------------------------------------
// Dispatch helper
// ---------------------------------------------------------------------------

/**
 * Build a `WakeSignalPayload` from the reconciler's locals and emit it via
 * the supplied sink. Skips cleanly with a debug log when `parentSessionId`
 * is missing — the wake has no addressable target in that case.
 *
 * Errors raised by the sink propagate to the caller; the reconciler is
 * expected to wrap this call in a try/catch so a sink failure does not
 * fail the surrounding `respond()` operation.
 */
export async function dispatchWake(
  sink: WakeSignalSink,
  args: {
    askId: string;
    parentSessionId: string | undefined;
    parentTaskId: string | undefined;
    reviewBody: string;
    reviewState: string;
    reviewAuthor: string | null;
    prNumber: number;
  }
): Promise<void> {
  if (!args.parentSessionId) {
    log.debug("ask.wake.skipped", {
      askId: args.askId,
      reason: "missing parentSessionId",
    });
    return;
  }

  const payload: WakeSignalPayload = {
    askId: args.askId,
    parentSessionId: args.parentSessionId,
    parentTaskId: args.parentTaskId,
    reviewBody: args.reviewBody,
    reviewState: args.reviewState,
    reviewAuthor: args.reviewAuthor,
    prNumber: args.prNumber,
  };

  await sink.emit(payload);
}
