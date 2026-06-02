/**
 * createTimeoutFetch tests (mt#2245).
 *
 * Verifies the bounded-timeout wrapper that backs the github-issues Octokit
 * client: a non-responding request rejects promptly (not an unbounded hang),
 * fast responses pass through, and a caller-supplied abort signal still cancels.
 */
import { describe, test, expect } from "bun:test";
import {
  createTimeoutFetch,
  GitHubRequestTimeoutError,
  GITHUB_REQUEST_TIMEOUT_MS,
} from "./octokit-timeout";

const CALLER_ABORT_REASON = "aborted by caller";

describe("createTimeoutFetch (mt#2245)", () => {
  test("rejects with GitHubRequestTimeoutError within timeout+1s when the request never responds", async () => {
    const neverResolves: typeof fetch = () => new Promise<Response>(() => {});
    const timeoutFetch = createTimeoutFetch(50, neverResolves);

    const start = performance.now();
    let caught: unknown;
    try {
      await timeoutFetch("https://api.github.com/repos/edobry/minsky/issues");
    } catch (err) {
      caught = err;
    }
    const elapsedMs = performance.now() - start;

    expect(caught).toBeInstanceOf(GitHubRequestTimeoutError);
    expect((caught as GitHubRequestTimeoutError).timeoutMs).toBe(50);
    expect(elapsedMs).toBeLessThan(50 + 1000);
  });

  test("passes a fast response through unchanged", async () => {
    const fastFetch: typeof fetch = async () => new Response("ok", { status: 200 });
    const timeoutFetch = createTimeoutFetch(1000, fastFetch);

    const res = await timeoutFetch("https://api.github.com/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("a caller-provided abort signal still cancels the request", async () => {
    // baseFetch rejects when the (chained) signal aborts.
    const abortableFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(CALLER_ABORT_REASON)));
      });
    const timeoutFetch = createTimeoutFetch(10_000, abortableFetch);

    const controller = new AbortController();
    const pending = timeoutFetch("https://api.github.com/x", { signal: controller.signal });
    controller.abort(new Error(CALLER_ABORT_REASON));

    await expect(pending).rejects.toThrow(CALLER_ABORT_REASON);
  });

  test("timeout wins over a fetch that rejects on abort, surfacing the timeout error (abort rejection suppressed)", async () => {
    // Mirrors real fetch: rejects once the (chained) signal aborts. The wrapper
    // must surface the timeout error from the race, and the late abort-driven
    // rejection of the underlying fetch must not become an unhandled rejection.
    const abortRejectingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      });
    const timeoutFetch = createTimeoutFetch(30, abortRejectingFetch);

    await expect(timeoutFetch("https://api.github.com/x")).rejects.toBeInstanceOf(
      GitHubRequestTimeoutError
    );
  });

  test("default deadline is 30s", () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
