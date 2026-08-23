import { describe, test, expect } from "bun:test";
import { isProviderHealthSignal, isRetryableAIError } from "./request-resilience";
import { ProviderInputError, RateLimitError } from "./enhanced-error-types";

/** The exact error OpenAI returned 76 times on 2026-08-17 (mt#4212). */
const OVERSIZE_INPUT_MESSAGE =
  "Embedding request failed: 400 Bad Request - type=invalid_request_error, " +
  "message=Invalid 'input[12]': maximum input length is 8192 tokens.";

describe("isProviderHealthSignal (mt#4212)", () => {
  test("a rejected request body is not evidence about the provider", () => {
    const err = new ProviderInputError(OVERSIZE_INPUT_MESSAGE, "openai", 400);
    expect(isProviderHealthSignal(err)).toBe(false);
  });

  test("an untyped error carrying the same rejection shape is also excluded", () => {
    // Defense for input errors raised outside the provider services.
    expect(isProviderHealthSignal(new Error(OVERSIZE_INPUT_MESSAGE))).toBe(false);
  });

  test("a rate limit IS evidence about the provider", () => {
    expect(isProviderHealthSignal(new RateLimitError("429 rate limited", "openai", 60, 0, 0))).toBe(
      true
    );
  });

  test("server errors, network errors and quota exhaustion count", () => {
    for (const msg of [
      "Embedding request failed: 503 Service Unavailable",
      "fetch failed: ECONNRESET",
      "code=insufficient_quota, message=You exceeded your current quota",
    ]) {
      expect(isProviderHealthSignal(new Error(msg))).toBe(true);
    }
  });

  test("an unclassified error defaults to counting", () => {
    // Narrowing wrongly would silently disable the breaker — the worse failure.
    expect(isProviderHealthSignal(new Error("something nobody anticipated"))).toBe(true);
  });
});

describe("isRetryableAIError with ProviderInputError (mt#4212)", () => {
  test("a rejected request body is never retried", () => {
    expect(isRetryableAIError(new ProviderInputError("400 Bad Request", "openai", 400))).toBe(
      false
    );
  });

  test("retryable classes are unchanged", () => {
    expect(isRetryableAIError(new RateLimitError("429", "openai", 60, 0, 0))).toBe(true);
    expect(isRetryableAIError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRetryableAIError(new Error("code=insufficient_quota"))).toBe(false);
  });
});
