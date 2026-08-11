/**
 * mt#3740 — superseded records do not double-count.
 *
 * A detector that fires on `Stop` sees a GROWING transcript, so a verdict it
 * forms early can be formed on a partial session and later become stale rather
 * than wrong. Such a detector writes a fresh record naming the one it replaces
 * (`supersedes`). The superseded record stays in the log — the revision history
 * is the point — but it is not its own review-worthy fire, or one session reads
 * as two.
 *
 * Split into its own file rather than added to `calibration-sweep.test.ts`
 * because that file is at the 1500-line ceiling; this mirrors the existing
 * `calibration-sweep.review-due.test.ts` split. All in-memory, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import { computeLogResult, type CalibrationLogEntry } from "./calibration-sweep";

const CAUSAL_ENTRY: CalibrationLogEntry = {
  path: ".minsky/causal-premise-calibration.jsonl",
  name: "causal-premise",
  kind: "causal-premise",
};

/**
 * A causal-premise-shaped record with the shared fields this task cares about.
 * The KIND is incidental — `supersedes` is a shared field parsed for every
 * detector, so any valid record shape exercises it.
 */
function makeRevisableRecord(
  timestamp: string,
  opts: { supersedes?: string; suppressionReasons?: string[] } = {}
): string {
  return JSON.stringify({
    timestamp,
    session_id: "revised-session",
    matchedPhrases: [`phrase-at-${timestamp}`],
    hadSameTurnVerification: false,
    suppressionReasons: opts.suppressionReasons ?? [],
    ...(opts.supersedes === undefined ? {} : { supersedes: opts.supersedes }),
  });
}

describe("supersedes accounting (mt#3740)", () => {
  test("a revised session contributes exactly one outcome, not two", () => {
    const first = makeRevisableRecord("2026-08-11T01:00:00.000Z");
    const revision = makeRevisableRecord("2026-08-11T02:00:00.000Z", {
      supersedes: "2026-08-11T01:00:00.000Z",
    });
    const unrelated = [3, 4, 5]
      .map((h) => makeRevisableRecord(`2026-08-11T0${h}:00:00.000Z`))
      .join("\n");
    const result = computeLogResult(
      CAUSAL_ENTRY,
      `${first}\n${revision}\n${unrelated}`,
      true,
      undefined
    );

    // Positional bookkeeping is untouched — the watermark is a record COUNT and
    // every record, superseded or not, is still in the file.
    expect(result.firesSinceLastReview).toBe(5);
    // Five records, four outcomes: the superseded one is not its own.
    expect(result.injectedFiresSinceLastReview).toBe(4);
  });

  test("a record that is both suppressed and superseded is removed ONCE", () => {
    // The double-subtraction trap: treating suppressed and superseded as two
    // independent deductions would take this record off the total twice and
    // under-report the injected count.
    const first = makeRevisableRecord("2026-08-11T01:00:00.000Z", {
      suppressionReasons: ["propagation-in-window"],
    });
    const revision = makeRevisableRecord("2026-08-11T02:00:00.000Z", {
      supersedes: "2026-08-11T01:00:00.000Z",
    });
    const result = computeLogResult(CAUSAL_ENTRY, `${first}\n${revision}`, true, undefined);

    expect(result.firesSinceLastReview).toBe(2);
    expect(result.suppressedSinceLastReview).toBe(1);
    // 2 records - 1 that is both suppressed AND superseded = 1, not 0.
    expect(result.injectedFiresSinceLastReview).toBe(1);
  });

  test("a supersedes marker pointing at nothing removes no record", () => {
    // Fail-safe direction: a dangling marker must not silently delete a fire
    // from the counts.
    const dangling = makeRevisableRecord("2026-08-11T02:00:00.000Z", {
      supersedes: "2026-01-01T00:00:00.000Z",
    });
    const result = computeLogResult(CAUSAL_ENTRY, dangling, true, undefined);

    expect(result.firesSinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(1);
  });

  test("a non-string supersedes is ignored rather than coerced", () => {
    // A malformed marker must not suppress a real record from the counts.
    const malformed = JSON.stringify({
      timestamp: "2026-08-11T02:00:00.000Z",
      session_id: "revised-session",
      matchedPhrases: ["phrase"],
      hadSameTurnVerification: false,
      suppressionReasons: [],
      supersedes: 42,
    });
    const result = computeLogResult(CAUSAL_ENTRY, malformed, true, undefined);

    expect(result.injectedFiresSinceLastReview).toBe(1);
  });
});
