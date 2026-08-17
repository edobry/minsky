import { describe, test, expect } from "bun:test";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { isRetryableAIError } from "./request-resilience";
import { ProviderInputError } from "./enhanced-error-types";

const PROVIDER = "openai-embeddings";
const THRESHOLD = 5;

/** Fast config: the real retry loop with no real delays (mt#2980 seam). */
function fastRetryService(): IntelligentRetryService {
  return new IntelligentRetryService({
    maxRetries: 3,
    baseDelay: 1,
    maxDelay: 5,
    jitterMaxMs: 0,
    circuitBreakerThreshold: THRESHOLD,
    circuitBreakerTimeout: 60_000,
  });
}

const quotaError = (): Error =>
  new Error("Embedding request failed: 429 - code=insufficient_quota");

async function failNTimes(
  service: IntelligentRetryService,
  n: number,
  makeError: () => Error
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await service
      .execute(
        async () => {
          throw makeError();
        },
        isRetryableAIError,
        PROVIDER
      )
      .catch(() => undefined);
  }
}

describe("circuit breaker error classification (mt#4212)", () => {
  test("rejected request bodies never open the breaker, however many there are", async () => {
    const service = fastRetryService();

    // 76 is the count observed in the originating incident, well past the
    // threshold of 5 — under the pre-fix code the breaker opened at 5 and the
    // remaining calls were rejected without ever reaching the provider.
    await failNTimes(
      service,
      76,
      () => new ProviderInputError("400 - maximum input length is 8192 tokens", "openai", 400)
    );

    expect(service.isProviderHealthy(PROVIDER)).toBe(true);
    expect(service.getCircuitBreakerStatus()[PROVIDER]).toBeUndefined();
  });

  test("an unrelated caller still succeeds after a burst of input errors", async () => {
    const service = fastRetryService();
    await failNTimes(
      service,
      76,
      () => new ProviderInputError("400 - maximum input length", "openai", 400)
    );

    // This is what the incident actually cost: memory search, task search and
    // knowledge sync share this breaker and were blacked out by a backfill's
    // bad input.
    const result = await service.execute(async () => "ok", isRetryableAIError, PROVIDER);
    expect(result).toBe("ok");
  });

  test("provider-health failures still open the breaker at the threshold", async () => {
    const service = fastRetryService();

    // `insufficient_quota` is the one-failure-per-call probe: non-retryable (so
    // `execute` does not multiply it by the retry count) but squarely a
    // statement about the provider account, so it must still be counted.
    await failNTimes(service, THRESHOLD, quotaError);

    expect(service.isProviderHealthy(PROVIDER)).toBe(false);
    await expect(service.execute(async () => "ok", isRetryableAIError, PROVIDER)).rejects.toThrow(
      /Circuit breaker is open/
    );
  });

  test("input errors do not contribute to a later health-driven trip", async () => {
    const service = fastRetryService();

    await failNTimes(
      service,
      THRESHOLD - 1,
      () => new ProviderInputError("400 - maximum input length", "openai", 400)
    );
    await failNTimes(service, THRESHOLD - 1, quotaError);

    // 4 counted failures is under the threshold — the 4 input errors must not
    // have been banked toward it.
    expect(service.isProviderHealthy(PROVIDER)).toBe(true);

    // ...and the 5th counted failure still trips it, so the breaker is armed,
    // not disabled.
    await failNTimes(service, 1, quotaError);
    expect(service.isProviderHealthy(PROVIDER)).toBe(false);
  });
});
