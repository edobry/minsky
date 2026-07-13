/**
 * Network-call timeout wrapper for the reviewer service.
 *
 * Bun's `fetch()` and the model/Octokit SDKs that depend on it have no
 * default timeout. A hung outbound call holds the webhook response open
 * until the platform kills the worker (~30-60s on Railway, longer
 * elsewhere) — making error-mode debugging hard and inflating tail
 * latency for downstream consumers.
 *
 * `withTimeout` wraps a promise-returning callable with an
 * `AbortController` + a racing rejection. On timeout:
 *
 *   1. The controller is aborted — SDKs that respect `signal` cancel
 *      their underlying request.
 *   2. A structured-shape log line is emitted via the reviewer-local
 *      winston logger (`log.error`) with `event: "timeout"`, the
 *      operation name, and elapsed-ms. In STRUCTURED mode this lands
 *      on stdout as a JSON line; in HUMAN mode as a colorised summary.
 *   3. A typed `TimeoutError` is thrown so the caller can distinguish
 *      timeouts from other failures.
 *
 * The underlying SDK call may continue running in the background after
 * timeout if the SDK ignores the `signal` argument. Memory cost is
 * bounded by GC; correctness is unaffected because the caller has
 * already moved on.
 *
 * mt#1086. Logger adoption completed in mt#1982 (post-mt#1255 scope).
 */

import { log } from "./logger";

/**
 * Thrown by `withTimeout` when an operation exceeds its budget. Carries
 * the operation name and the timeout that was applied so callers can
 * format an actionable error response (e.g., HTTP 500 with a stable
 * `op` label for log correlation).
 */
export class TimeoutError extends Error {
  public readonly op: string;
  public readonly timeoutMs: number;

  constructor(op: string, timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms: ${op}`);
    this.name = "TimeoutError";
    this.op = op;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `fn` with a hard timeout. Returns `fn`'s resolved value on success;
 * throws `TimeoutError` on timeout; propagates any other error `fn` throws.
 *
 * @param op           Stable operation name for log correlation. Use a
 *                     namespaced form like `"openai.chat.completions.create"`
 *                     or `"github.pulls.listFiles"` so log readers can group
 *                     timeouts by surface.
 * @param timeoutMs    Milliseconds to wait before aborting and rejecting.
 *                     Must be a positive finite integer; values that aren't
 *                     are passed through to `setTimeout` unchanged (Bun
 *                     coerces; the caller is responsible for validation
 *                     at config-load time).
 * @param fn           A factory that accepts an `AbortSignal` and returns
 *                     a `Promise<T>`. The signal is aborted when the
 *                     timeout elapses, so SDKs that support cancellation
 *                     (OpenAI, Anthropic, Octokit) free their socket and
 *                     stop processing immediately.
 */
export async function withTimeout<T>(
  op: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const start = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const durationMs = Date.now() - start;
      log.error("timeout", {
        event: "timeout",
        op,
        timeoutMs,
        durationMs,
      });
      controller.abort();
      reject(new TimeoutError(op, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
