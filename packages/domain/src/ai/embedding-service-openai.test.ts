import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIEmbeddingService } from "./embedding-service-openai";
import { isRetryableAIError, isRequestTimeoutError } from "./request-resilience";
import { RateLimitError } from "./enhanced-error-types";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";

// mt#2980: injected in place of the module's shared retry service for tests
// that actually exercise the retry loop, following the
// `postgres-channel-listener.test.ts` `FAST_RETRY` precedent. `jitterMaxMs: 0`
// is required in addition to tiny `baseDelay`/`maxDelay` — the shared
// service's jitter is a flat `Math.random() * jitterMaxMs` addition
// independent of `baseDelay`, so omitting it would still leave up to 1000ms
// of real sleep per retry.
const FAST_RETRY = new IntelligentRetryService({
  maxRetries: 3,
  baseDelay: 1,
  maxDelay: 5,
  jitterMaxMs: 0,
});

const originalFetch = globalThis.fetch;

// Shared test constants to avoid magic string duplication
const TEST_API_KEY = "test-key";
const TEST_BASE_URL = "https://api.example.test/v1";
const TEST_MODEL = "text-embedding-3-small";
const STATUS_TOO_MANY = "Too Many Requests";
const MSG_RATE_LIMIT = "Rate limit reached";
const CODE_INSUFFICIENT_QUOTA = "insufficient_quota";

function createService() {
  return new OpenAIEmbeddingService(TEST_API_KEY, TEST_BASE_URL, TEST_MODEL);
}

/**
 * Mock fetch that always returns the same response on every call.
 * This is important because requestWithRetry may call request() multiple times
 * (retry + fallback).
 */
function mockFetchAlways(
  status: number,
  statusText: string,
  body: unknown,
  headers?: Record<string, string>
) {
  // @ts-expect-error -- assigning a partial Response mock to globalThis.fetch for test isolation
  globalThis.fetch = async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: new Headers(headers || {}),
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
      async json() {
        return typeof body === "string" ? JSON.parse(body) : body;
      },
    } as Response;
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAIEmbeddingService error formatting", () => {
  it("formats 400 errors with provider code/message details when JSON provided", async () => {
    const svc = createService();
    mockFetchAlways(400, "Bad Request", {
      error: {
        type: "invalid_request_error",
        code: "content_policy_violation",
        message: "Input too long for model",
      },
    });

    let err: unknown = null;
    try {
      await svc.generateEmbedding("x".repeat(200000));
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    const msg = String((err as Error)?.message || err);
    expect(msg).toContain("Embedding request failed: 400 Bad Request");
    expect(msg).toContain("content_policy_violation");
    expect(msg).toContain("Input too long for model");
  });
});

describe("OpenAIEmbeddingService rate limit handling", () => {
  // These tests use retry-after: 0 so the retry service doesn't sleep.
  // The final throw after exhausting retries is the RateLimitError we check.

  it("throws RateLimitError on 429 with retryAfter from Retry-After header", async () => {
    const svc = createService();
    // Call request() directly to avoid retry service delays that exceed test timeout.
    mockFetchAlways(
      429,
      STATUS_TOO_MANY,
      {
        error: {
          type: "requests",
          code: "rate_limit_exceeded",
          message: MSG_RATE_LIMIT,
        },
      },
      {
        "retry-after": "5",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-limit-requests": "60",
      }
    );

    let err: unknown = null;
    try {
      await (svc as any).request(["test input"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RateLimitError);
    const rle = err as RateLimitError;
    expect(rle.remaining).toBe(0);
    expect(rle.limit).toBe(60);
    expect(rle.retryAfter).toBe(5);
    expect(rle.provider).toBe("openai");
    expect(rle.message).toContain("429");
  });

  it("falls back to x-ratelimit-reset-requests when Retry-After is absent", async () => {
    const svc = createService();
    // Call request() directly to avoid retry service delays.
    mockFetchAlways(
      429,
      STATUS_TOO_MANY,
      { error: { type: "requests", message: MSG_RATE_LIMIT } },
      { "x-ratelimit-reset-requests": "30" }
    );

    let err: unknown = null;
    try {
      await (svc as any).request(["test input"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(30);
  });

  it("defaults retryAfter to 60 when no rate-limit headers present", async () => {
    // Test the request() method's default retryAfter by accessing it directly.
    // This avoids the retry service's sleep(retryAfter * 1000) which would time out.
    const svc = createService();
    mockFetchAlways(429, STATUS_TOO_MANY, {
      error: { type: "requests", message: MSG_RATE_LIMIT },
    });

    let err: unknown = null;
    try {
      // Call request() directly to avoid retry delays
      await (svc as any).request(["test input"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(60);
  });

  it("throws plain Error (not RateLimitError) on 429 with insufficient_quota", async () => {
    const svc = createService();
    mockFetchAlways(429, STATUS_TOO_MANY, {
      error: {
        type: CODE_INSUFFICIENT_QUOTA,
        code: CODE_INSUFFICIENT_QUOTA,
        message: "You exceeded your current quota",
      },
    });

    let err: unknown = null;
    try {
      await svc.generateEmbedding("test input");
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error)?.message || err);
    expect(msg).toContain(CODE_INSUFFICIENT_QUOTA);
  });
});

describe("OpenAIEmbeddingService shouldRetry logic", () => {
  it("retries on 429 rate limit (RateLimitError) and eventually succeeds", async () => {
    // mt#2980: inject FAST_RETRY so this test exercises the real retry loop
    // (retryable-error detection + a genuine second attempt) without paying
    // real backoff/jitter delay — previously ~1.12s per the mt#2933 baseline.
    const svc = new OpenAIEmbeddingService(TEST_API_KEY, TEST_BASE_URL, TEST_MODEL, FAST_RETRY);

    let callCount = 0;
    // @ts-expect-error -- assigning mock to globalThis.fetch for test isolation
    globalThis.fetch = async () => {
      callCount++;
      if (callCount <= 1) {
        return {
          ok: false,
          status: 429,
          statusText: STATUS_TOO_MANY,
          headers: new Headers({ "retry-after": "0" }),
          async json() {
            return { error: { type: "requests", message: "Rate limit" } };
          },
          async text() {
            return '{"error":{"type":"requests","message":"Rate limit"}}';
          },
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        async json() {
          return { data: [{ embedding: [0.1, 0.2] }] };
        },
      } as Response;
    };

    const result = await svc.generateEmbedding("test");
    expect(result).toEqual([0.1, 0.2]);
    expect(callCount).toBeGreaterThan(1);
  });

  it("does not retry on insufficient_quota 429", async () => {
    const svc = createService();

    let callCount = 0;
    // @ts-expect-error -- assigning mock to globalThis.fetch for test isolation
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
        statusText: STATUS_TOO_MANY,
        headers: new Headers(),
        async json() {
          return {
            error: {
              type: CODE_INSUFFICIENT_QUOTA,
              code: CODE_INSUFFICIENT_QUOTA,
              message: "You exceeded your current quota",
            },
          };
        },
        async text() {
          return `{"error":{"code":"${CODE_INSUFFICIENT_QUOTA}"}}`;
        },
      } as Response;
    };

    let err: unknown = null;
    try {
      await svc.generateEmbedding("test");
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    const msg = String((err as Error)?.message || err);
    expect(msg).toContain(CODE_INSUFFICIENT_QUOTA);
    // requestWithRetry catches the retry service's throw, then does a single
    // fallback request() — so we expect at most 2 fetch calls per attempt cycle:
    // retry service calls request() once, shouldRetry returns false, throws;
    // catch clause calls request() once more as fallback.
    expect(callCount).toBeLessThanOrEqual(2);
  });
});

describe("isRetryableAIError", () => {
  it("returns true for RateLimitError (transient 429)", () => {
    const err = new RateLimitError("Rate limited", "openai", 5, 0, 60);
    expect(isRetryableAIError(err)).toBe(true);
  });

  it("returns false for insufficient_quota errors", () => {
    const err = new Error("insufficient_quota: You exceeded your current quota");
    expect(isRetryableAIError(err)).toBe(false);
  });

  it("returns true for 502 Bad Gateway", () => {
    const err = new Error("502 Bad Gateway");
    expect(isRetryableAIError(err)).toBe(true);
  });

  it("returns true for 503 Service Unavailable", () => {
    const err = new Error("503 Service Unavailable");
    expect(isRetryableAIError(err)).toBe(true);
  });

  it("returns true for network errors (ECONNRESET, ETIMEDOUT)", () => {
    expect(isRetryableAIError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableAIError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("returns true for generic 429 message", () => {
    const err = new Error("Request failed: 429 Too Many Requests");
    expect(isRetryableAIError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRetryableAIError(new Error("Invalid API key"))).toBe(false);
    expect(isRetryableAIError(new Error("Bad request"))).toBe(false);
  });

  it("handles non-Error values gracefully", () => {
    expect(isRetryableAIError("some string")).toBe(false);
    expect(isRetryableAIError(null)).toBe(false);
    expect(isRetryableAIError(undefined)).toBe(false);
  });

  // mt#3444: an `AbortSignal.timeout` rejection is a `TimeoutError` whose
  // message is "The operation timed out." — matching NONE of the tokens above
  // (`ETIMEDOUT` does not match "timed out"). Before this classification, adding
  // a request timeout would have converted an unbounded hang into a
  // NON-retryable single-shot failure.
  it("returns true for a request-timeout rejection (classified by name, not message)", () => {
    const err = new DOMException("The operation timed out.", "TimeoutError");
    expect(isRequestTimeoutError(err)).toBe(true);
    expect(isRetryableAIError(err)).toBe(true);
    // Guard the reason this needs name-based classification: the message alone
    // does not match the retryable-token regex.
    expect(
      /429|rate.limit|502|Bad Gateway|503|Service Unavailable|ECONNRESET|ETIMEDOUT/i.test(
        err.message
      )
    ).toBe(false);
  });

  it("does NOT treat a caller-initiated abort as retryable", () => {
    // A deliberate `controller.abort()` produces AbortError — retrying a
    // cancellation the caller asked for would be wrong.
    const err = new DOMException("This operation was aborted", "AbortError");
    expect(isRequestTimeoutError(err)).toBe(false);
    expect(isRetryableAIError(err)).toBe(false);
  });
});

/**
 * mt#4985 — the timeout classification's verdict, or a DESCRIPTION of whatever
 * error arrived instead.
 *
 * ## Why this exists
 *
 * `isRequestTimeoutError` is `error?.name === "TimeoutError"`, so a bare
 * `expect(isRequestTimeoutError(err)).toBe(true)` fails with
 * `Expected: true, Received: false` and says NOTHING about what actually
 * rejected. On 2026-09-04 this test failed once under the full gated suite
 * (2570 tests / 199 files) and passed 3/3 in isolation, and the record it left
 * behind was exactly those two words — so the cause could not be determined
 * afterwards, and the flake is too rare to reproduce on demand.
 *
 * Routing the assertion through this function makes the SAME failure carry the
 * error's `name` and `message`, so the next occurrence diagnoses itself in one
 * shot instead of requiring a reproduction.
 *
 * The failure line the incident DID leave is worth keeping in view: `[5.56ms]`
 * against a 150ms `TIMEOUT_MS`. The request rejected ~27x faster than the
 * timeout it should have hit, so the abort never fired — a startup- or
 * connection-shaped failure rather than a slow one. That is a direction, not a
 * diagnosis, which is why this ships instrumentation and not a fix.
 *
 * Deliberately NOT a timing change and NOT a mock: it reads only the error
 * object the test already caught, adds no clock dependency, and leaves the real
 * stalled server in place — the design this suite's docblock below insists on.
 */
function timeoutVerdict(err: unknown): string {
  if (isRequestTimeoutError(err)) return "TimeoutError";
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof e?.name === "string" && e.name ? e.name : "(no name)";
  const message = typeof e?.message === "string" && e.message ? e.message : String(err);
  return `${name}: ${message}`;
}

/**
 * mt#3444 — the request timeout, exercised against a REAL stalled server.
 *
 * These deliberately do NOT mock `fetch`: the defect was that the real
 * `fetch` never self-times-out, so a mocked rejection would prove nothing about
 * whether the fix works. Each test stands up a local server that accepts the
 * connection and never responds — the exact production failure shape.
 */
describe("OpenAIEmbeddingService request timeout (mt#3444)", () => {
  const TIMEOUT_MS = 150; // tiny bound so the suite stays fast
  let stalled: ReturnType<typeof Bun.serve> | null = null;

  function startStalledServer() {
    stalled = Bun.serve({
      port: 0,
      fetch() {
        // Accept, then never respond.
        return new Promise<Response>(() => {});
      },
    });
    return `http://127.0.0.1:${stalled.port}/v1`;
  }

  afterEach(() => {
    stalled?.stop(true);
    stalled = null;
  });

  // mt#4985 AT1. The instrumentation's own check, and deliberately deterministic:
  // it constructs the errors rather than waiting for the rare flake to recur, so
  // the diagnostic is verified in one run. This does NOT replace the real-socket
  // tests below — it only pins what they will report when they fail.
  it("mt#4985: the timeout verdict names the error that actually arrived", () => {
    // The passing shape: a real timeout collapses to the bare verdict, so the
    // assertion below reads identically to the classification it replaced.
    expect(timeoutVerdict(new DOMException("The operation timed out.", "TimeoutError"))).toBe(
      "TimeoutError"
    );

    // The failing shapes: each names itself. The first is not invented — it is the
    // VERBATIM rejection bun produces for an unreachable port, captured by running
    // this suite against a dead one (mt#4985's negative control). Note its `name`
    // is plain `Error`, not `TypeError`, which is exactly why a name-based
    // classification silently rejects it.
    expect(
      timeoutVerdict(new Error("Unable to connect. Is the computer able to access the url?"))
    ).toBe("Error: Unable to connect. Is the computer able to access the url?");
    expect(timeoutVerdict(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(timeoutVerdict(new DOMException("This operation was aborted", "AbortError"))).toBe(
      "AbortError: This operation was aborted"
    );

    // Non-Error rejections fall back to `String(err)`, which is an improvement for
    // the primitives below and NOT a general guarantee: a plain object still
    // stringifies to "[object Object]", as the last case pins. That is acceptable
    // here — the rejections this suite can actually produce are Errors and
    // DOMExceptions — but the fallback should not be read as more than it is.
    expect(timeoutVerdict("boom")).toBe("(no name): boom");
    expect(timeoutVerdict(null)).toBe("(no name): null");
    expect(timeoutVerdict({})).toBe("(no name): [object Object]");
  });

  it("AT1: a stalled single request rejects within the bound instead of hanging", async () => {
    const url = startStalledServer();
    const svc = new OpenAIEmbeddingService(
      TEST_API_KEY,
      url,
      TEST_MODEL,
      new IntelligentRetryService({ maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMaxMs: 0 }),
      TIMEOUT_MS
    );

    const started = performance.now();
    let err: unknown = null;
    try {
      await svc.generateEmbedding("probe");
    } catch (e) {
      err = e;
    }
    const elapsed = performance.now() - started;

    expect(err).toBeTruthy();
    // mt#4985: routed through `timeoutVerdict` so a failure names the error that
    // actually arrived. Same pass/fail behaviour as the bare classification check.
    expect(timeoutVerdict(err)).toBe("TimeoutError");
    // Bounded: well under the 1800s hang this replaces, and comfortably above
    // the configured bound. Generous upper bound to stay non-flaky under load.
    expect(elapsed).toBeLessThan(5000);
    // The `- 50` is the LOWER bound's tolerance, and it is load-bearing (mt#3551):
    // a real elapsed measurement compared against the exact configured bound can
    // land a hair under it — the sibling assertion in push-operations.test.ts read
    // 19 against a 20ms bound in CI and failed the required `build` check. 50ms
    // against a 150ms bound is ~33% margin, far above the ~1-2ms skew involved.
    // Do not tighten it to `TIMEOUT_MS`.
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
  });

  it("AT3: a stalled BATCH request rejects within the bound too", async () => {
    const url = startStalledServer();
    const svc = new OpenAIEmbeddingService(
      TEST_API_KEY,
      url,
      TEST_MODEL,
      new IntelligentRetryService({ maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMaxMs: 0 }),
      TIMEOUT_MS
    );

    let err: unknown = null;
    try {
      await svc.generateEmbeddings(["a", "b", "c"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // mt#4985: same instrumentation as AT1 — this test stands up the same real
    // stalled server and carries the same failure mode, so it gets the same
    // diagnostic rather than waiting to be the next one that fails opaquely.
    expect(timeoutVerdict(err)).toBe("TimeoutError");
  });

  it("AT2: the timeout is retried by the retry service (not a single-shot failure)", async () => {
    const url = startStalledServer();
    let attempts = 0;
    const countingRetry = new IntelligentRetryService({
      maxRetries: 2,
      baseDelay: 1,
      maxDelay: 5,
      jitterMaxMs: 0,
    });
    // Variadic cast: the wrapper forwards whatever arity the caller used, and
    // `...(rest as [])` below spread an EMPTY tuple, so the call site supplied
    // only one of `execute`'s 2-3 parameters.
    const realExecute = countingRetry.execute.bind(countingRetry) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    countingRetry.execute = ((fn: () => Promise<unknown>, ...rest: unknown[]) =>
      realExecute(
        async () => {
          attempts++;
          return fn();
        },
        ...rest
      )) as typeof countingRetry.execute;

    const svc = new OpenAIEmbeddingService(
      TEST_API_KEY,
      url,
      TEST_MODEL,
      countingRetry,
      TIMEOUT_MS
    );

    try {
      await svc.generateEmbedding("probe");
    } catch {
      // expected
    }

    // The whole point: a non-settling promise could never reach attempt 2.
    expect(attempts).toBeGreaterThan(1);
  });

  it("AT5: a stall is recorded as errorCode 'timeout', not the catch-all 'unknown'", async () => {
    const url = startStalledServer();
    EmbeddingsHealthTracker.resetForTest();
    const tracker = EmbeddingsHealthTracker.getInstance();
    const recorded: Array<{ provider: string; errorCode: string }> = [];
    const realRecordError = tracker.recordError.bind(tracker);
    tracker.recordError = async (provider: string, errorCode: string, message: string) => {
      recorded.push({ provider, errorCode });
      return realRecordError(provider, errorCode, message);
    };

    const svc = new OpenAIEmbeddingService(
      TEST_API_KEY,
      url,
      TEST_MODEL,
      new IntelligentRetryService({ maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMaxMs: 0 }),
      TIMEOUT_MS
    );

    try {
      await svc.generateEmbedding("probe");
    } catch {
      // expected
    } finally {
      tracker.recordError = realRecordError;
      EmbeddingsHealthTracker.resetForTest();
    }

    // The operator-visible half: a stall must be distinguishable from an error
    // the API returned. Before this change it fell through to "unknown".
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.errorCode).toBe("timeout");
    expect(recorded[0]?.provider).toBe("openai");
  });

  it("AT4: a normal (fast) request is unaffected by the bound", async () => {
    const ok = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      },
    });
    try {
      const svc = new OpenAIEmbeddingService(
        TEST_API_KEY,
        `http://127.0.0.1:${ok.port}/v1`,
        TEST_MODEL,
        FAST_RETRY,
        TIMEOUT_MS
      );
      const vec = await svc.generateEmbedding("probe");
      expect(vec).toEqual([0.1, 0.2, 0.3]);
    } finally {
      ok.stop(true);
    }
  });
});
