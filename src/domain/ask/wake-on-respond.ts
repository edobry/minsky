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
 * Minimal logger interface needed by `LoggingWakeSignalSink`.
 *
 * Defining this as a structural subset of the project logger gives tests a
 * clean DI seam without test-only `as` casts: pass a recording fake whose
 * shape exactly matches what the sink uses (`cli` and `cliWarn`).
 *
 * `cli` is used because the project's agent-logger methods (`log.info`,
 * `log.debug`, `log.warn`) are explicitly no-ops in HUMAN mode (the default)
 * unless `ENABLE_AGENT_LOGS=true`. The `cli*` family routes through the
 * program logger, which always emits regardless of log mode — see
 * `src/utils/logger.ts`. Without this routing the wake event is silently
 * dropped for default deployments.
 */
export interface WakeSinkLogger {
  cli(message: unknown): void;
  cliWarn(message: unknown): void;
}

/** Tag prefix on every wake log line — operators grep on this. */
const WAKE_LOG_TAG = "ask.wake";

/** Tag prefix when a wake is intentionally skipped (no parentSessionId). */
const WAKE_SKIPPED_LOG_TAG = "ask.wake.skipped";

/**
 * Default `WakeSignalSink` that writes the wake event to the program logger so
 * it always emits regardless of log mode.
 *
 * Per mt#1481's transport-availability analysis at the time of shipping:
 *   - mt#1001 (mesh push): not yet built — research-stage TODO
 *   - mt#697 (AG-UI interrupt): evaluation only, recommended NOT for mesh push
 *   - mt#1144 (cockpit shell): not yet built
 *
 * Output format on stdout: `ask.wake <JSON-payload>` — operators tail and
 * grep with `grep '"event":"ask.wake"'` (or simpler: `grep '^ask\.wake'`).
 * The DI seam is the `WakeSinkLogger` interface above; tests inject a
 * recording fake.
 *
 * **Field contract** (operators filter on these — do not change without
 * updating the spec and the regression test in `wake-on-respond.test.ts`):
 *   - JSON `event`: always `"ask.wake"` — the routing/filtering key
 *   - JSON `cause`: identifies the upstream transition that triggered the wake;
 *     `"quality.review.responded"` for the mt#1481 path
 *   - All seven `WakeSignalPayload` fields are spread into the JSON
 *   - Line prefix is the literal string `ask.wake` followed by a single space
 *
 * When mt#1001 / mt#1144 lands, swap this default at composition time —
 * no other change to the reconciler required.
 */
export class LoggingWakeSignalSink implements WakeSignalSink {
  private readonly logger: WakeSinkLogger;

  constructor(logger?: WakeSinkLogger) {
    this.logger = logger ?? log;
  }

  emit(signal: WakeSignalPayload): void {
    const payload = {
      event: WAKE_LOG_TAG,
      cause: "quality.review.responded",
      ...signal,
    };
    this.logger.cli(`${WAKE_LOG_TAG} ${JSON.stringify(payload)}`);
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
    // Use log.cli (program logger) so the skip is visible in default HUMAN
    // mode — log.debug is suppressed there. Operators diagnosing missing
    // wakes need this breadcrumb. Same channel as the success path; tag
    // differs so grep on `ask.wake.skipped` separates the two cases.
    log.cli(
      `${WAKE_SKIPPED_LOG_TAG} ${JSON.stringify({
        event: WAKE_SKIPPED_LOG_TAG,
        askId: args.askId,
        reason: "missing parentSessionId",
      })}`
    );
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
