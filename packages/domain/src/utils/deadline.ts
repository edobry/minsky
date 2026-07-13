/**
 * Wall-clock deadline guarantee for a single async operation (mt#2677).
 *
 * `session_pr_drive`'s review-wait and checks-wait poll loops compute their
 * timeout by checking `now() >= deadline` BETWEEN iterations, but never bound
 * the async work done WITHIN a single iteration (a GitHub API fetch, a
 * token-mint call, etc.). If one of those calls stalls with no timeout of its
 * own (as `github-app-token-provider.ts`'s installation-token exchange did —
 * see the sibling fix in that file), the whole poll loop hangs past its
 * configured `reviewTimeoutSeconds` / `checksTimeoutSeconds` with no bound at
 * all, until the MCP client's own unrelated idle timeout kills the
 * connection.
 *
 * `withDeadline` closes that gap generically: wrap any per-iteration async
 * call with it and the wrapped promise is GUARANTEED to settle by
 * `timeoutMs`, even if the underlying promise never settles.
 */

/** Thrown by the deadline race when `timeoutMs` elapses before `promise` settles. */
export class DeadlineExceededError extends Error {
  constructor(message = "Operation exceeded its wall-clock deadline") {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Race `promise` against a real `setTimeout(timeoutMs)`. Deliberately uses a
 * REAL timer, independent of any caller-injected fake clock (`now`/`sleep`
 * test seams elsewhere in this module) — this is a genuine wall-clock
 * guarantee, not a simulated one, so it must not be foolable by a fake-clock
 * test double. Callers that want to exercise the "stalled forever" branch in
 * a test pass a small real `timeoutMs` (e.g. 50-200ms) and a never-resolving
 * `promise`; see `octokit-timeout.test.ts` for the established pattern of
 * asserting bounded elapsed time on a real timer in a fast unit test.
 *
 * `timeoutMs <= 0` rejects immediately (deadline already passed) without
 * scheduling a timer.
 *
 * The abandoned `promise`'s eventual settlement (resolve OR reject) is
 * swallowed with a no-op handler once attached, so a late resolution/rejection
 * from an abandoned stalled operation never surfaces as an unhandled
 * rejection after the deadline branch has already won the race.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // Prevent the abandoned promise's eventual outcome (in either direction)
  // from becoming an unhandled rejection once the deadline branch wins.
  void promise.catch(() => {});

  if (timeoutMs <= 0) {
    return Promise.reject(
      new DeadlineExceededError(`Deadline already exceeded (timeoutMs=${timeoutMs})`)
    );
  }

  // `| undefined` (rather than a definite-assignment assertion) so this
  // stays correct even if a future refactor moves the Promise executor
  // somewhere non-synchronous — the `timer &&` guard below then degrades to
  // "nothing to clear" instead of crashing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError()), timeoutMs);
  });
  // The executor above runs synchronously (per the Promise spec), so `timer`
  // is always assigned by this point. unref() so a pending deadline timer
  // never keeps the process alive on its own once nothing else is pending —
  // relevant for short-lived scripts/tests that finish before the deadline
  // naturally (e.g. this module's own tests, and any CLI-style caller).
  if (timer && typeof timer.unref === "function") timer.unref();

  // Promise.race settles on whichever of `promise`/`deadline` settles FIRST;
  // the loser's eventual settlement is simply ignored — a promise settles at
  // most once (Promises/A+), so no manual "already settled" flag is needed
  // here. `clearTimeout` on an already-fired (or already-cleared) timer is a
  // documented no-op, so calling it unconditionally in `.finally()` below is
  // always safe regardless of which branch won the race.
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
