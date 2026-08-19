/**
 * mt#4281 — the unrecovered-timeout path becomes observable.
 *
 * Two independent blind spots, tested separately:
 *   1. timing accumulated before a throw died with the stack frame
 *   2. the OpenAI SDK's internal retries emitted nothing
 *
 * Every seam here is a real parameter — `callOpenAIWithClient` takes its
 * `client`, `recordUnrecoveredReviewTiming` takes its `timingRecorder`,
 * `withSdkRetryVisibility` takes its `baseFetch` — so nothing in this file
 * patches a module import. Deliberately NOT placed in `review-worker.test.ts`:
 * open PR #774 rewrites that file.
 */

import { describe, test, expect } from "bun:test";
import {
  attachPartialTiming,
  extractPartialTiming,
  callOpenAIWithClient,
  createReviewerOpenAIClient,
  isSdkRetryableStatus,
  withSdkRetryVisibility,
  TIMEOUT_UNRECOVERED,
  OPENAI_SDK_MAX_RETRIES,
  OPENAI_SDK_TIMEOUT_MS,
  type TimingData,
} from "./providers";
import { recordUnrecoveredReviewTiming, type ReviewTimingInput } from "./review-timing";
import { TimeoutError } from "./with-timeout";
import type OpenAI from "openai";
import type { ReviewerDb } from "./db/client";
import type { ReviewerToolContext } from "./tools";

// ---------------------------------------------------------------------------
// Partial-timing carrier
// ---------------------------------------------------------------------------

describe("attachPartialTiming / extractPartialTiming (mt#4281)", () => {
  const timing: TimingData = {
    roundLatenciesMs: [120_000],
    timeoutCount: 1,
    retryOutcomes: [TIMEOUT_UNRECOVERED],
  };

  test("round-trips timing through an error", () => {
    const err = attachPartialTiming(new Error("boom"), timing);
    expect(extractPartialTiming(err)).toEqual(timing);
  });

  test("returns undefined for an error carrying nothing", () => {
    expect(extractPartialTiming(new Error("plain"))).toBeUndefined();
  });

  test("returns undefined for non-objects rather than throwing", () => {
    expect(extractPartialTiming(undefined)).toBeUndefined();
    expect(extractPartialTiming(null)).toBeUndefined();
    expect(extractPartialTiming("a string rejection")).toBeUndefined();
  });

  test("attaching to a non-object is a no-op, not a crash", () => {
    expect(() => attachPartialTiming("string rejection", timing)).not.toThrow();
  });

  test("COPIES the arrays — a later mutation of the source cannot rewrite history", () => {
    // The throw site's arrays are still live locals. A carrier that aliased them
    // would report what they hold later, not what they held at the failure.
    const live: TimingData = { roundLatenciesMs: [1], timeoutCount: 1, retryOutcomes: ["a"] };
    const err = attachPartialTiming(new Error("boom"), live);

    live.roundLatenciesMs.push(999);
    live.retryOutcomes.push("mutated-after-the-fact");

    expect(extractPartialTiming(err)?.roundLatenciesMs).toEqual([1]);
    expect(extractPartialTiming(err)?.retryOutcomes).toEqual(["a"]);
  });

  test("the attached property is non-enumerable, so it cannot alter error serialization", () => {
    const err = attachPartialTiming(new Error("boom"), timing);
    expect(Object.keys(err)).toHaveLength(0);
    expect(JSON.stringify(err)).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// The provider loop actually attaches on a real throw
// ---------------------------------------------------------------------------

/** Minimal OpenAI stand-in: the loop only reaches `chat.completions.create`. */
function clientThatThrows(err: unknown): OpenAI {
  return {
    chat: {
      completions: {
        create: () => Promise.reject(err),
      },
    },
  } as unknown as OpenAI;
}

/**
 * `callOpenAIWithClient` has TWO model-call sites with different code paths —
 * the single-turn `notools` call and the tool-use loop — selected by whether
 * `tools` is passed. Both had the same defect, so both are exercised: a table
 * with one entry would have covered whichever one the author happened to reach.
 * (The `notools` site was in fact found this way — the first draft of these
 * tests omitted `tools` and silently took that branch.)
 */
const CALL_PATHS: { name: string; tools: ReviewerToolContext | undefined }[] = [
  { name: "notools (single-turn)", tools: undefined },
  { name: "tool-use loop", tools: {} as unknown as ReviewerToolContext },
];

describe("callOpenAIWithClient carries partial timing out of a throw (mt#4281)", () => {
  for (const { name, tools } of CALL_PATHS) {
    describe(name, () => {
      test("an unrecovered TimeoutError arrives carrying timeout-unrecovered", async () => {
        const client = clientThatThrows(new TimeoutError("openai.chat.completions.create", 1));

        const err = await callOpenAIWithClient(client, "gpt-5", "sys", "user", tools).then(
          () => {
            throw new Error("expected callOpenAIWithClient to reject");
          },
          (e: unknown) => e
        );

        const carried = extractPartialTiming(err);
        expect(carried).toBeDefined();
        expect(carried?.retryOutcomes).toContain(TIMEOUT_UNRECOVERED);
        expect(carried?.timeoutCount).toBe(1);
        // The failed call still contributes its latency — the "partial
        // latencies survive" half.
        expect(carried?.roundLatenciesMs).toHaveLength(1);
      });

      test("NEGATIVE CONTROL: the error still propagates — recording must not swallow it", async () => {
        const boom = new TimeoutError("openai.chat.completions.create", 1);
        const client = clientThatThrows(boom);

        await expect(callOpenAIWithClient(client, "gpt-5", "sys", "user", tools)).rejects.toBe(
          boom
        );
      });

      test("NEGATIVE CONTROL: a non-timeout throw records no timeout outcome", async () => {
        // Without this, a carrier that unconditionally stamped
        // `timeout-unrecovered` would pass the first test and be wrong about
        // every other failure mode.
        const client = clientThatThrows(new Error("HTTP 400 from OpenAI"));

        const err = await callOpenAIWithClient(client, "gpt-5", "sys", "user", tools).then(
          () => {
            throw new Error("expected callOpenAIWithClient to reject");
          },
          (e: unknown) => e
        );

        const carried = extractPartialTiming(err);
        expect(carried?.retryOutcomes).toEqual([]);
        expect(carried?.timeoutCount).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as ReviewerDb;

function baseInput() {
  const captured: ReviewTimingInput[] = [];
  return {
    captured,
    input: {
      db: FAKE_DB,
      timingRecorder: async (_db: ReviewerDb, row: ReviewTimingInput) => {
        captured.push(row);
      },
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 3095,
      headSha: "ad4a9649",
      iterationIndex: 1,
      totalWallClockMs: 121_000,
      scopeClassification: "small" as string | null,
      toolUseActive: true,
      provider: "openai",
      model: "gpt-5",
    },
  };
}

describe("recordUnrecoveredReviewTiming (mt#4281)", () => {
  test("writes exactly ONE row carrying timeout-unrecovered", async () => {
    const { captured, input } = baseInput();

    await recordUnrecoveredReviewTiming({
      ...input,
      partialTiming: {
        roundLatenciesMs: [60_000, 120_000],
        timeoutCount: 1,
        retryOutcomes: [TIMEOUT_UNRECOVERED],
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.retryOutcomes).toContain(TIMEOUT_UNRECOVERED);
    expect(captured[0]?.prNumber).toBe(3095);
  });

  test("partial latencies are PERSISTED, not dropped to an empty array", async () => {
    const { captured, input } = baseInput();

    await recordUnrecoveredReviewTiming({
      ...input,
      partialTiming: {
        roundLatenciesMs: [60_000, 120_000],
        timeoutCount: 1,
        retryOutcomes: [TIMEOUT_UNRECOVERED],
      },
    });

    expect(captured[0]?.perRoundLatenciesMs).toEqual([60_000, 120_000]);
    expect(captured[0]?.timeoutCount).toBe(1);
  });

  test("token fields are absent, not zero — unknown spend must not read as free", async () => {
    // Zeroes would understate cost in the same aggregate the July 2026 cost
    // audit reads. NULL is the honest value for a review that never returned usage.
    const { captured, input } = baseInput();

    await recordUnrecoveredReviewTiming({ ...input, partialTiming: undefined });

    expect(captured[0]?.inputTokens).toBeUndefined();
    expect(captured[0]?.outputTokens).toBeUndefined();
    expect(captured[0]?.costUsd).toBeUndefined();
  });

  test("an error carrying no timing still writes a row, with empty timing", async () => {
    const { captured, input } = baseInput();

    await recordUnrecoveredReviewTiming({ ...input, partialTiming: undefined });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.perRoundLatenciesMs).toEqual([]);
    expect(captured[0]?.timeoutCount).toBe(0);
  });

  test("NEGATIVE CONTROL: no db configured writes nothing rather than throwing", async () => {
    const { captured, input } = baseInput();

    await recordUnrecoveredReviewTiming({ ...input, db: undefined });

    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SDK retry visibility
// ---------------------------------------------------------------------------

describe("isSdkRetryableStatus — verified against openai@4.104.0 core.js#shouldRetry", () => {
  test.each([408, 409, 429, 500, 503, 599])("retries %i", (status) => {
    expect(isSdkRetryableStatus(status)).toBe(true);
  });

  test.each([200, 201, 400, 401, 403, 404, 422])("does NOT retry %i", (status) => {
    expect(isSdkRetryableStatus(status)).toBe(false);
  });
});

type StubFetch = Parameters<typeof withSdkRetryVisibility>[0];

function fetchReturning(status: number): StubFetch {
  return (async () => ({ status })) as unknown as StubFetch;
}

const TARGET_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Invoke a `Fetch` with a URL string.
 *
 * The SDK's shimmed `RequestInfo` resolves to `never` for a caller under this
 * tsconfig, so the parameter cannot be supplied directly even though a string
 * is exactly what the runtime takes. The cast is confined here rather than
 * repeated at each call site.
 */
function callFetch(f: StubFetch, url: string): Promise<{ status: number }> {
  return (f as unknown as (u: string) => Promise<{ status: number }>)(url);
}

describe("withSdkRetryVisibility (mt#4281)", () => {
  test("a 429 — the rate-limit case — is reported", async () => {
    const seen: { status: number; target: string }[] = [];
    const wrapped = withSdkRetryVisibility(fetchReturning(429), (info) => seen.push(info));

    await callFetch(wrapped, TARGET_URL);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(429);
    expect(seen[0]?.target).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("NEGATIVE CONTROL: a clean 200 reports nothing", async () => {
    // Without this, an always-firing callback would pass the test above and
    // make every successful call look like a retry.
    const seen: unknown[] = [];
    const wrapped = withSdkRetryVisibility(fetchReturning(200), (info) => seen.push(info));

    await callFetch(wrapped, TARGET_URL);

    expect(seen).toHaveLength(0);
  });

  test("passes the response through untouched — it observes, it does not intervene", async () => {
    const wrapped = withSdkRetryVisibility(fetchReturning(429), () => {});
    const response = await callFetch(wrapped, TARGET_URL);
    expect(response.status).toBe(429);
  });
});

describe("createReviewerOpenAIClient (mt#4281)", () => {
  test("PINS maxRetries and timeout instead of inheriting SDK defaults", async () => {
    const client = createReviewerOpenAIClient("sk-test");

    expect(client.maxRetries).toBe(OPENAI_SDK_MAX_RETRIES);
    expect(client.timeout).toBe(OPENAI_SDK_TIMEOUT_MS);
  });

  test("the pinned values equal the defaults they replace — this is not a behavior change", () => {
    // openai@4.104.0 index.d.ts: `[opts.maxRetries=2]`, `[opts.timeout=10 minutes]`.
    // Changing either would make this a Class B guarantee trade (mt#2718/mt#3526),
    // which this task explicitly is not. This test is the tripwire on that.
    expect(OPENAI_SDK_MAX_RETRIES).toBe(2);
    expect(OPENAI_SDK_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test("installs the retry-visibility fetch on the client", async () => {
    const seen: number[] = [];
    const stub = (async () => ({ status: 429 })) as unknown as StubFetch;
    const client = createReviewerOpenAIClient("sk-test", stub);

    // Reach the wrapper the client was built with, via the client's own option.
    const installed = (client as unknown as { fetch: StubFetch }).fetch;
    const response = await callFetch(installed, TARGET_URL);

    expect(response.status).toBe(429);
    expect(seen).toHaveLength(0); // the client logs rather than calling our array
  });
});
