/**
 * mt#1962 — retry-aware controller for the MCP daemon's DI initialization.
 *
 * The daemon's stdio-mode startup pattern (set by mt#1751) defers
 * `container.initialize()` out of the protocol-handshake hot path: the
 * MCP `initialize` JSON-RPC handshake completes before DI runs; every
 * DI-dependent tool call awaits the in-flight init before dispatching.
 *
 * Pre-mt#1962, that init was a single long-lived `Promise<void>` plumbed
 * through `setInitPromise`. Promises are at-most-once: if the first attempt
 * rejected (DB unreachable, missing migrations folder, slow Postgres
 * handshake, port collision, etc.), every subsequent tool call awaited the
 * same rejected promise and returned the same error indefinitely. The
 * daemon became a zombie that required a manual `proxy_restart_server`
 * (or process-level kill) to clear.
 *
 * `RetryingInitController` replaces the bare promise with a controller
 * that tracks attempt state and re-invokes the initializer on demand
 * (next tool call) when a prior attempt rejected, subject to a backoff
 * cap. Successful results are cached: once an attempt resolves, every
 * subsequent `awaitReady()` returns the resolved promise (O(1)).
 *
 * Design notes:
 *
 * - Retry is demand-driven, not timer-driven. Idle daemons generate zero
 *   DB load; recovery happens when the user actually wants something.
 * - Concurrent callers collapse to the single in-flight attempt — N
 *   simultaneous tool calls during an in-flight retry produce exactly one
 *   `initializer()` invocation.
 * - The clock is injectable so backoff behavior is fully testable without
 *   `setTimeout` / wall-clock waits.
 * - The `onAttemptSettled` callback emits ONE structured log line per
 *   actual attempt (not per tool-call), so operators see "still failing
 *   after N attempts" without parsing every tool-call error.
 * - Error-surfacing contract is preserved: when an attempt rejects (or a
 *   backoff-blocked call would re-throw), the awaiter sees the actual
 *   rejection, not a generic "init pending" message.
 *
 * Scope and non-goals (PR #1188 R1 NB2):
 *
 * - The controller retries TRANSIENT INITIALIZATION FAILURE. It is not a
 *   health monitor and does not detect post-init environment breakage.
 *   Once an attempt resolves successfully, the cached promise is reused
 *   for every subsequent `awaitReady()` call — forever. If a downstream
 *   resource (DB connection, file handle, network peer) breaks AFTER a
 *   successful init, the controller will not re-attempt; tool calls will
 *   fail in whatever way the broken resource surfaces.
 * - Recovery from post-init resource failure is the responsibility of the
 *   layer that owns the resource (connection pools that reconnect on
 *   failure, query-time retry wrappers, etc.) — not this controller.
 * - The contract is "one-shot success caches; only failure retries."
 */

export interface InitController {
  awaitReady(): Promise<void>;
}

export interface AttemptResult {
  /** 1-indexed attempt counter over the controller's lifetime. */
  attempt: number;
  /** Cumulative failure count since the last success (resets to 0 on success). */
  consecutiveFailures: number;
  /** ms-since-epoch when the attempt started. */
  startedAt: number;
  /** ms-since-epoch when the attempt settled. */
  settledAt: number;
  /** undefined on success; the rejection reason on failure. */
  error: unknown | undefined;
}

export interface RetryingInitControllerOptions {
  /**
   * The initialization function to retry on demand. Must be idempotent on
   * the success path (a successful return MUST mean the resource is ready
   * for use). Failures may have side-effects (partial state); the next
   * attempt is responsible for handling that.
   */
  initializer: () => Promise<void>;
  /**
   * Minimum interval between attempt STARTS, in milliseconds. Calls to
   * `awaitReady()` arriving within this window after a failure re-throw
   * the prior rejection synchronously rather than starting a new attempt.
   * @default 30_000 (30 seconds)
   */
  minRetryIntervalMs?: number;
  /**
   * Clock function — returns ms-since-epoch. Injectable for tests.
   * @default Date.now
   */
  now?: () => number;
  /**
   * Called once per settled attempt (success or failure). Useful for
   * structured logging — emits exactly one line per actual attempt
   * regardless of how many tool calls awaited it.
   */
  onAttemptSettled?: (result: AttemptResult) => void;
}

type AttemptState = "in-flight" | "succeeded" | "failed";

interface CurrentAttempt {
  promise: Promise<void>;
  state: AttemptState;
  startedAt: number;
}

export class RetryingInitController implements InitController {
  private readonly initializer: () => Promise<void>;
  private readonly minRetryIntervalMs: number;
  private readonly now: () => number;
  private readonly onAttemptSettled: ((result: AttemptResult) => void) | undefined;

  private current: CurrentAttempt | null = null;
  private lastFailure: { error: unknown; attemptStartedAt: number } | null = null;
  private attemptCount = 0;
  private consecutiveFailures = 0;

  constructor(options: RetryingInitControllerOptions) {
    this.initializer = options.initializer;
    this.minRetryIntervalMs = options.minRetryIntervalMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onAttemptSettled = options.onAttemptSettled;
  }

  awaitReady(): Promise<void> {
    if (this.current && this.current.state !== "failed") {
      return this.current.promise;
    }
    if (this.lastFailure) {
      const elapsedSinceStart = this.now() - this.lastFailure.attemptStartedAt;
      if (elapsedSinceStart < this.minRetryIntervalMs) {
        return Promise.reject(this.lastFailure.error);
      }
    }
    return this.startAttempt();
  }

  private startAttempt(): Promise<void> {
    const startedAt = this.now();
    const attemptNumber = ++this.attemptCount;

    const promise = (async () => {
      try {
        await this.initializer();
        this.lastFailure = null;
        this.consecutiveFailures = 0;
        if (this.current) {
          this.current.state = "succeeded";
        }
        this.emit({
          attempt: attemptNumber,
          consecutiveFailures: 0,
          startedAt,
          settledAt: this.now(),
          error: undefined,
        });
      } catch (err) {
        this.consecutiveFailures++;
        this.lastFailure = { error: err, attemptStartedAt: startedAt };
        if (this.current && this.current.startedAt === startedAt) {
          this.current.state = "failed";
        }
        this.emit({
          attempt: attemptNumber,
          consecutiveFailures: this.consecutiveFailures,
          startedAt,
          settledAt: this.now(),
          error: err,
        });
        throw err;
      }
    })();

    this.current = { promise, state: "in-flight", startedAt };
    return promise;
  }

  private emit(result: AttemptResult): void {
    if (!this.onAttemptSettled) return;
    try {
      this.onAttemptSettled(result);
    } catch {
      // Observer errors must never affect the controller's behavior.
    }
  }
}
