/**
 * Generic, injectable "race an async operation against a timeout" helper
 * (mt#3049, extracted from `session-commands.ts` for mt#3177 so the git
 * domain package can share it without a session -> git layering violation).
 *
 * This module intentionally has ZERO dependencies on any Minsky domain
 * concept — it is a pure timing primitive usable by any package.
 */

/** Real `setTimeout`-backed timeout signal — the non-test default for `raceAgainstTimeout`. */
function defaultTimeoutSignal(ms: number): Promise<{ timedOut: true }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), ms);
  });
}

/**
 * Generic bounded race between a real async operation and a timeout signal.
 * Returns a discriminated result so callers never need to infer "timed out"
 * from an operation's own return shape.
 *
 * Note: this bounds the CALLER's wait only — it does not cancel `operation`.
 * A timed-out operation may still resolve or reject in the background after
 * this function returns `{ timedOut: true }`. Callers that need to know
 * whether the abandoned operation eventually succeeded should follow up with
 * an independent, out-of-band check (e.g. re-reading the state the operation
 * was meant to change) rather than assuming failure.
 *
 * `timeoutSignal` is injectable so tests can simulate an instantly-elapsed
 * timeout without any real wall-clock wait — pair an injected `timeoutSignal`
 * that resolves immediately with an `operation` that never resolves on its
 * own (e.g. `new Promise(() => {})`) to deterministically exercise the
 * "timeout wins" branch in well under a millisecond.
 */
export function raceAgainstTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutSignal: (ms: number) => Promise<{ timedOut: true }> = defaultTimeoutSignal
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return Promise.race([
    operation.then((value) => ({ timedOut: false as const, value })),
    timeoutSignal(timeoutMs),
  ]);
}
