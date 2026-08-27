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

/** The error a caller must still receive — never a TypeError from the carrier. */
const REAL_FAILURE_MESSAGE = "the real failure";

/** `withTimeout`'s op name for the OpenAI model call. */
const TOOLLOOP_OP = "openai.chat.completions.create";

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

  // --- PR #3136 R1 (BLOCKING): masking the original failure -----------------
  //
  // `Object.defineProperty` throws on a non-extensible object. Every caller is
  // `throw attachPartialTiming(err, …)` inside a catch, so an unguarded throw
  // would replace the real error with a TypeError. Losing the timing is
  // acceptable; losing the error is not.

  // NOTE on assertion style: these assert the RETURN VALUE rather than using
  // `expect(fn).not.toThrow()`. `attachPartialTiming` returns the error itself,
  // and bun's `toThrow` matcher reads a returned Error as a thrown one — so the
  // negated form fails against correct code. Returning the identical object is
  // the stronger claim anyway: it cannot pass unless the call completed.

  test("R1: a FROZEN error is returned untouched instead of throwing", () => {
    const frozen = Object.freeze(new Error(REAL_FAILURE_MESSAGE));

    // Unguarded, `Object.defineProperty` throws here and this line never returns.
    expect(attachPartialTiming(frozen, timing)).toBe(frozen);
    expect(frozen.message).toBe(REAL_FAILURE_MESSAGE);
  });

  test("R1: a SEALED error is returned untouched instead of throwing", () => {
    const sealed = Object.seal(new Error(REAL_FAILURE_MESSAGE));

    expect(attachPartialTiming(sealed, timing)).toBe(sealed);
    expect(extractPartialTiming(sealed)).toBeUndefined();
  });

  test("R1: an error whose defineProperty trap throws is still returned", () => {
    // Covers the residue `isExtensible` cannot see — the pre-check alone would
    // pass this object straight through to a throwing defineProperty.
    const hostile = new Proxy(new Error(REAL_FAILURE_MESSAGE), {
      defineProperty() {
        throw new TypeError("trap");
      },
    });

    expect(attachPartialTiming(hostile, timing)).toBe(hostile);
  });

  test("R1 NEGATIVE CONTROL: an ordinary extensible error still gets its timing", () => {
    // Without this, a guard that gave up on EVERY error would pass the three
    // tests above while silently disabling the whole feature.
    const ordinary = new Error(REAL_FAILURE_MESSAGE);

    expect(extractPartialTiming(attachPartialTiming(ordinary, timing))).toEqual(timing);
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
        const client = clientThatThrows(new TimeoutError(TOOLLOOP_OP, 1));

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
        const boom = new TimeoutError(TOOLLOOP_OP, 1);
        const client = clientThatThrows(boom);

        await expect(callOpenAIWithClient(client, "gpt-5", "sys", "user", tools)).rejects.toBe(
          boom
        );
      });

      test("R1: a FROZEN error propagates unchanged — the carrier never masks it", async () => {
        // The end-to-end form of the R1 finding: what actually matters is not
        // that `attachPartialTiming` returns, but that the ORIGINAL error still
        // arrives at the caller. A TypeError here would look like a reviewer
        // bug rather than the timeout it really was.
        const frozen = Object.freeze(new TimeoutError(TOOLLOOP_OP, 1)) as TimeoutError;
        const client = clientThatThrows(frozen);

        await expect(callOpenAIWithClient(client, "gpt-5", "sys", "user", tools)).rejects.toBe(
          frozen
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

/** mt#4556: the configuration arm the caller stamps on this path. */
const FINGERPRINT = "v1;effort=low;model=gpt-5;provider=openai;tier2=off";

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
      configFingerprint: FINGERPRINT,
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
    // mt#4556 AT5: this path has no model OUTPUT to derive from — the call
    // threw — but a call was attempted, so the row must still name the
    // configuration arm it was attempted under.
    expect(captured[0]?.configFingerprint).toBe(FINGERPRINT);
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

/** As {@link callFetch}, with the request headers the SDK would have stamped. */
function callFetchWithHeaders(
  f: StubFetch,
  url: string,
  headers: Record<string, string>
): Promise<{ status: number }> {
  return (
    f as unknown as (
      u: string,
      init: { headers: Record<string, string> }
    ) => Promise<{ status: number }>
  )(url, { headers });
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

  test("reports the SDK's own 1-based attempt number, read off x-stainless-retry-count", async () => {
    // openai@4.104.0 stamps this header with `maxRetries - retriesRemaining`,
    // a 0-based index, so retryCount 1 is the SECOND attempt.
    const seen: (number | null)[] = [];
    const wrapped = withSdkRetryVisibility(fetchReturning(429), (info) => seen.push(info.attempt));

    await callFetchWithHeaders(wrapped, TARGET_URL, { "x-stainless-retry-count": "1" });

    expect(seen).toEqual([2]);
  });

  test("the FIRST attempt reads as 1, not as a retry", async () => {
    const seen: (number | null)[] = [];
    const wrapped = withSdkRetryVisibility(fetchReturning(500), (info) => seen.push(info.attempt));

    await callFetchWithHeaders(wrapped, TARGET_URL, { "x-stainless-retry-count": "0" });

    expect(seen).toEqual([1]);
  });

  test("reports null rather than fabricating a number when the header is absent", async () => {
    // A made-up attempt number is worse than a missing one — it reads as measured.
    const seen: (number | null)[] = [];
    const wrapped = withSdkRetryVisibility(fetchReturning(429), (info) => seen.push(info.attempt));

    await callFetch(wrapped, TARGET_URL);

    expect(seen).toEqual([null]);
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

  test("R1: constructs WITHOUT a global fetch instead of throwing ReferenceError", () => {
    // The previous `baseFetch: FetchLike = fetch` default evaluated a bare
    // global at call time. Where it is absent that is a ReferenceError at
    // construction — a dead reviewer, traded for instrumentation.
    const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    try {
      Reflect.deleteProperty(globalThis, "fetch");

      expect(() => createReviewerOpenAIClient("sk-test")).not.toThrow();
      // The pinned budget survives the fallback — only visibility is lost.
      const client = createReviewerOpenAIClient("sk-test");
      expect(client.maxRetries).toBe(OPENAI_SDK_MAX_RETRIES);
      expect(client.timeout).toBe(OPENAI_SDK_TIMEOUT_MS);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "fetch", original);
    }
  });

  test("R1 NEGATIVE CONTROL: with a global fetch present, the wrapper IS installed", () => {
    // Without this, a fallback that ALWAYS skipped instrumentation would pass
    // the test above while shipping no retry visibility at all.
    const client = createReviewerOpenAIClient("sk-test");
    expect(typeof (client as unknown as { fetch?: unknown }).fetch).toBe("function");
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
