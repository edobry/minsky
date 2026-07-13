/**
 * Bounded network timeout for Octokit clients (mt#2245).
 *
 * Modern Octokit (`@octokit/rest` v22 / core v9) uses the native `fetch` and no
 * longer honors the legacy `request.timeout` option — a hung GitHub call is
 * therefore effectively unbounded (mt#2186 observed single requests taking
 * 27-38 minutes, which wedged the long-lived cockpit-server process). The
 * supported way to bound a request is to supply a custom `request.fetch` that
 * races the underlying fetch against an AbortController deadline.
 *
 * `createTimeoutFetch()` wraps a base fetch so every request the Octokit
 * instance makes (including retry attempts) is aborted after `timeoutMs`,
 * converting an infinite hang into a prompt rejection that callers already
 * handle (the github-issues backend wraps each call in try/catch and returns a
 * clean error result).
 *
 * Reused by the github-issues backend now; the remaining Octokit construction
 * sites are swept in mt#2270.
 */

/** Default per-request deadline for GitHub API calls. */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** Thrown (via AbortController reason) when a GitHub request exceeds the deadline. */
export class GitHubRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`GitHub request timed out after ${timeoutMs}ms`);
    this.name = "GitHubRequestTimeoutError";
  }
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * Wrap `baseFetch` so each call is aborted after `timeoutMs`. A caller-supplied
 * `init.signal` is chained, so external aborts (e.g. Octokit's own request
 * signal) still propagate. The timer is always cleared once the request settles.
 *
 * @param timeoutMs deadline per request (default {@link GITHUB_REQUEST_TIMEOUT_MS})
 * @param baseFetch underlying fetch (default global `fetch`; injectable for tests)
 */
export function createTimeoutFetch(
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  const timeoutFetch = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    // The timeout promise rejects independently of `baseFetch`, so the returned
    // promise is guaranteed to settle at the deadline even if the underlying
    // fetch were to ignore the abort signal. The `controller.abort` still fires
    // to cancel the in-flight request and free the socket when fetch honors it
    // (the native/undici fetch does).
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new GitHubRequestTimeoutError(timeoutMs);
        // Reject FIRST so the race deterministically settles with our timeout
        // error, then abort to cancel the socket. (Aborting first would let the
        // fetch's own abort-rejection win the race with whatever value that
        // implementation rejects with.)
        reject(err);
        controller.abort(err);
      }, timeoutMs);
    });

    // Chain any caller-provided signal so external aborts still cancel the request.
    const callerSignal = init?.signal ?? undefined;
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        onCallerAbort = () => controller.abort(callerSignal.reason);
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const fetchPromise = baseFetch(input, { ...init, signal: controller.signal });
    // When the timeout wins the race, the aborted fetch rejects on a later tick
    // with no handler on the race's losing branch — attach a no-op catch so that
    // late rejection doesn't surface as an unhandledRejection (the native/undici
    // fetch honors the abort and rejects). The race still observes fetchPromise's
    // settlement independently; genuine errors that win the race still propagate.
    void fetchPromise.catch(() => {});

    return Promise.race([fetchPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
      // Remove the abort listener when the request settles without the caller
      // signal firing, so a long-lived shared signal doesn't accumulate listeners.
      if (onCallerAbort && callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    });
  };

  return timeoutFetch as typeof fetch;
}
