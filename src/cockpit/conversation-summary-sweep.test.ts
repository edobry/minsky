/**
 * mt#3441 — the conversation-summary sweeper is `SummaryPipeline`'s invocation path.
 *
 * The defect this covers is an ABSENCE: the pipeline worked and its tests passed,
 * but nothing called it on a schedule, so 11 of 2,108 transcripts carried a
 * summary. A test that only exercised the pipeline would have stayed green
 * throughout. These tests assert the caller exists and is bounded.
 */
import { describe, test, expect } from "bun:test";
import { startConversationSummarySweeper } from "./sweepers";
import {
  SummaryPipeline,
  DEFAULT_SUMMARY_BATCH_SIZE,
  SUMMARY_BATCH_UNBOUNDED,
} from "@minsky/domain/transcripts/summary-pipeline";

/** Minimal stand-ins — `candidateConditions()` touches none of these. */
function makePipeline(options?: { force?: boolean }): SummaryPipeline {
  return new SummaryPipeline(
    {} as never, // db — unused by the query-shape accessor
    {} as never, // cognitionProvider
    {} as never, // embeddingService
    options
  );
}

const EMPTY_RUN = {
  transcriptsScanned: 0,
  transcriptsSkipped: 0,
  transcriptsProcessed: 0,
  transcriptsErrored: 0,
  embeddingCallsMade: 0,
};

/** Wait for at least one interval tick to have fired and settled. */
async function waitForTick(intervalMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, intervalMs * 4));
}

describe("SummaryPipeline batching contract (mt#3441)", () => {
  test("is bounded by default, so a new caller inherits the safe shape", () => {
    // The whole reason the pipeline had no sweeper: an unbounded default made it
    // unsafe to put on a timer. 25 matches DEFAULT_TITLE_BATCH_SIZE.
    expect(DEFAULT_SUMMARY_BATCH_SIZE).toBe(25);
  });

  test("unbounded is an explicit opt-out value, not the absence of one", () => {
    expect(SUMMARY_BATCH_UNBOUNDED).toBe(0);
    expect(SUMMARY_BATCH_UNBOUNDED).not.toBe(DEFAULT_SUMMARY_BATCH_SIZE);
  });

  test("candidate selection filters in SQL: has-transcript AND unsummarized", () => {
    // Asserted through the real drizzle condition builder rather than a fake DB,
    // mirroring TitlePipeline.candidateConditionCount().
    expect(makePipeline().candidateConditionCount()).toBe(2);
  });

  test("force drops the unsummarized filter rather than negating it", () => {
    expect(makePipeline({ force: true }).candidateConditionCount()).toBe(1);
  });
});

describe("conversation-summary sweeper (mt#3441)", () => {
  test("a tick actually invokes the pipeline — the caller that never existed", async () => {
    let calls = 0;
    const intervalMs = 5;
    const stop = startConversationSummarySweeper({
      intervalMs,
      deps: {
        runSummarizing: async () => {
          calls++;
          return EMPTY_RUN;
        },
      },
    });

    try {
      await waitForTick(intervalMs);
      expect(calls).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("a failing run degrades quietly and does not escape the tick", async () => {
    let calls = 0;
    const intervalMs = 5;
    const stop = startConversationSummarySweeper({
      intervalMs,
      deps: {
        runSummarizing: async () => {
          calls++;
          // Stands in for an AI failure or an unavailable embedding backend —
          // the latter is not hypothetical, the embeddings backend has been
          // observed quota-exhausted. A tick must cost one failed batch.
          throw new Error("embedding backend unavailable");
        },
      },
    });

    try {
      await waitForTick(intervalMs);
      expect(calls).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("stop() halts the sweeper — no ticks after it returns", async () => {
    let calls = 0;
    const intervalMs = 5;
    const stop = startConversationSummarySweeper({
      intervalMs,
      deps: {
        runSummarizing: async () => {
          calls++;
          return EMPTY_RUN;
        },
      },
    });

    await waitForTick(intervalMs);
    stop();
    const afterStop = calls;
    await waitForTick(intervalMs);

    // Also guards the duplicate-active-registration invariant: a sweeper that
    // never stopped would make the next registration of this name throw.
    expect(calls).toBe(afterStop);
  });
});
