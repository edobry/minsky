import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIEmbeddingService, isRetryableAIError } from "./embedding-service-openai";
import { RateLimitError } from "./enhanced-error-types";

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
    const svc = createService();

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
});
