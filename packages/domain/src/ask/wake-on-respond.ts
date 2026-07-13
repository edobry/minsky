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

import { log } from "@minsky/shared/logger";
import type { WakePendingRepository } from "./wake-pending-repository";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Wake-signal payload emitted when a `quality.review` Ask transitions to
 * `responded`. Field set is exactly the seven fields specified in mt#1481 —
 * no extras. Adding fields requires a spec update so downstream consumers
 * know what to expect.
 *
 * mt#1725 extended `WakeSignalPayload` with a `kind` discriminator so the same
 * table and delivery path can carry both Ask-review wakes (`"ask.review"`) and
 * PR-watch wakes (`"pr.watch"`). The discriminator is optional for backward
 * compatibility — legacy rows (from before mt#1725) omit it and are treated as
 * `"ask.review"` by consumers.
 *
 * For `"pr.watch"` wakes, `askId` holds the watch ID (a UUID), `reviewBody` /
 * `reviewState` / `reviewAuthor` hold the match description / event / watcher
 * identity respectively.
 */
export interface WakeSignalPayload {
  /**
   * Discriminator identifying which subsystem produced this wake.
   *
   * - `"ask.review"` — a `quality.review` Ask transitioned to `responded`
   *   (mt#1481 original path).
   * - `"pr.watch"` — a PR-watch predicate matched and the watch fired
   *   (mt#1725 extension).
   *
   * Absent in legacy rows (pre-mt#1725); treat as `"ask.review"` when absent.
   */
  kind?: "ask.review" | "pr.watch";
  /**
   * For `"ask.review"`: primary key of the Ask that just responded.
   * For `"pr.watch"`: primary key of the PrWatch that fired.
   */
  askId: string;
  /** Session UUID of the agent that originally filed the Ask / registered the watch. */
  parentSessionId: string;
  /** Task ID associated with the parent session, when present. */
  parentTaskId?: string;
  /**
   * For `"ask.review"`: body of the GitHub review that triggered the response.
   * For `"pr.watch"`: human-readable description of the matched event
   *   (e.g., `"PR #42 — APPROVED by minsky-reviewer[bot]"`).
   */
  reviewBody: string;
  /**
   * For `"ask.review"`: verdict of the review (APPROVED, CHANGES_REQUESTED, etc.).
   * For `"pr.watch"`: the PrWatchEvent that matched (`"merged"`, `"review-posted"`,
   *   or `"check-status-changed"`).
   */
  reviewState: string;
  /**
   * For `"ask.review"`: reviewer login (human or bot); null when GitHub did not return one.
   * For `"pr.watch"`: watcherId of the registered watch (operator identity string).
   */
  reviewAuthor: string | null;
  /** Pull request number the review was posted on / the watch targeted. */
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
// Persistent sink (mt#1661 v0): writes wake events to wake_pending table
// ---------------------------------------------------------------------------

/** Tag prefix when a persistent-sink write fails. */
const WAKE_PERSIST_FAILED_LOG_TAG = "ask.wake.persist.failed";

/**
 * `WakeSignalSink` that persists wake events to the `wake_pending` table for
 * later drain by the in-conversation pull-on-tool-call middleware
 * (`enrichWakeResponse`). Producer half of the mt#1519 §5 short-term bridge.
 *
 * Failure mode: a write failure is logged at the `ask.wake.persist.failed` tag
 * and re-thrown so the reconciler's existing try/catch wrapper can decide
 * whether to abort the surrounding `respond()` operation. This sink is not
 * silent: persistence-side outages should be visible.
 *
 * v0 scope: keys on `parentSessionId` only. Cross-session / agent-handoff
 * delivery requires the InterfaceBinding model (mt#1506); v0 covers only the
 * unambiguous case.
 */
export class PersistentWakeSignalSink implements WakeSignalSink {
  constructor(private readonly repo: WakePendingRepository) {}

  async emit(signal: WakeSignalPayload): Promise<void> {
    try {
      await this.repo.insert(signal);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.cli(
        `${WAKE_PERSIST_FAILED_LOG_TAG} ${JSON.stringify({
          event: WAKE_PERSIST_FAILED_LOG_TAG,
          askId: signal.askId,
          parentSessionId: signal.parentSessionId,
          error: errMsg,
        })}`
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Composite sink (mt#1661 v0): fan out emit() to N underlying sinks
// ---------------------------------------------------------------------------

/** Tag prefix when a composite child sink fails. */
const WAKE_COMPOSITE_CHILD_FAILED_LOG_TAG = "ask.wake.composite.child.failed";

/**
 * `WakeSignalSink` that fans out `emit()` to N underlying sinks. Used at
 * composition root to register `LoggingWakeSignalSink` + `PersistentWakeSignalSink`
 * (and any future sinks) so they fire in parallel on every wake.
 *
 * Failure isolation: one child sink failing does not prevent the others from
 * firing. Each child's error is logged at `ask.wake.composite.child.failed` and
 * collected. If ALL children failed, a single aggregated error is rethrown so
 * the reconciler's try/catch can act on it. If at least one child succeeded,
 * the composite returns normally — the wake reached at least one transport.
 *
 * Per mt#1481's contract, child sinks may throw and the reconciler is expected
 * to wrap dispatch in a try/catch. The composite preserves that contract while
 * adding partial-failure tolerance.
 */
export class CompositeWakeSignalSink implements WakeSignalSink {
  constructor(private readonly sinks: ReadonlyArray<WakeSignalSink>) {}

  async emit(signal: WakeSignalPayload): Promise<void> {
    if (this.sinks.length === 0) return;
    const errors: Array<{ index: number; error: Error }> = [];
    for (const [i, sink] of this.sinks.entries()) {
      try {
        await sink.emit(signal);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ index: i, error });
        log.cli(
          `${WAKE_COMPOSITE_CHILD_FAILED_LOG_TAG} ${JSON.stringify({
            event: WAKE_COMPOSITE_CHILD_FAILED_LOG_TAG,
            sinkIndex: i,
            askId: signal.askId,
            error: error.message,
          })}`
        );
      }
    }
    // All children failed — surface to caller so reconciler can decide.
    if (errors.length === this.sinks.length) {
      const summary = errors
        .map(({ index, error }) => `sink[${index}]: ${error.message}`)
        .join("; ");
      throw new Error(
        `CompositeWakeSignalSink: all ${this.sinks.length} sinks failed — ${summary}`
      );
    }
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
