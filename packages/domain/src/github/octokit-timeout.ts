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
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    });

    // Chain any caller-provided signal so external aborts still cancel the request.
    const callerSignal = init?.signal ?? undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), {
          once: true,
        });
      }
    }

    const fetchPromise = baseFetch(input, { ...init, signal: controller.signal });
    return Promise.race([fetchPromise, timeoutPromise]).finally(() => clearTimeout(timer));
  };

  return timeoutFetch as typeof fetch;
}
