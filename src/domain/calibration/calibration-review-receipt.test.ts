/**
 * Unit tests for the review-receipt half of the calibration sweep (mt#3906).
 *
 * Kept out of `calibration-sweep.test.ts` because that file already sits at the
 * 1500-line cap; all tests here operate on in-memory data, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import {
  advanceWatermarks,
  buildReviewToken,
  computeLogResult,
  InvalidReviewTokenError,
  parseReviewToken,
  reconcileReviewReceipt,
  FIRES_THRESHOLD,
  type CalibrationLogEntry,
  type LogWatermark,
  type WatermarkStore,
} from "./calibration-sweep";

const CAUSAL_ENTRY: CalibrationLogEntry = {
  path: ".minsky/causal-premise-calibration.jsonl",
  name: "causal-premise",
  kind: "causal-premise",
};

const ISSUED_AT = "2026-08-10T10:06:00Z";
const ACKED_AT = "2026-08-10T10:15:00Z";

function makeCausalRecord(phrase: string): string {
  return JSON.stringify({
    timestamp: "2026-08-10T10:00:00Z",
    session_id: "test-session",
    matchedPhrases: [phrase],
    hadSameTurnVerification: false,
  });
}

/** A sweep result for the causal log holding exactly `count` records. */
function causalResultAt(count: number, watermark?: LogWatermark) {
  const lines = Array.from({ length: count }, (_, i) => makeCausalRecord(`p${i}`)).join("\n");
  return computeLogResult(CAUSAL_ENTRY, lines, true, watermark);
}

describe("review receipts", () => {
  test("round-trips the counts a sweep observed", () => {
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT);
    const receipt = parseReviewToken(token);
    expect(receipt.issuedAt).toBe(ISSUED_AT);
    expect(receipt.counts[CAUSAL_ENTRY.path]).toBe(11);
  });

  test("AT1 — the watermark records the READ count, and the mid-pass tail stays unreviewed", () => {
    // Read at N, ack after the log has grown to N+K.
    const readCount = FIRES_THRESHOLD;
    // Sized to the count bar deliberately: `newRecords` is gated on
    // `atCountThreshold`, so a smaller tail would come back empty BY DESIGN and
    // the assertion below would pass for the wrong reason.
    const arrivedDuringPass = FIRES_THRESHOLD;
    const ackCount = readCount + arrivedDuringPass;

    const token = buildReviewToken([causalResultAt(readCount)], ISSUED_AT);
    const ackResults = [causalResultAt(ackCount)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});
    const updated = advanceWatermarks(
      {},
      ackResults,
      ackable,
      ACKED_AT,
      reconciliation.reviewedCounts
    );

    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedCount).toBe(readCount);

    // The K records that landed mid-pass are still unreviewed on the NEXT sweep
    // — the property that actually matters, checked end-to-end rather than
    // inferred from the watermark number alone.
    const nextSweep = causalResultAt(ackCount, updated[CAUSAL_ENTRY.path]);
    expect(nextSweep.firesSinceLastReview).toBe(arrivedDuringPass);
    expect(nextSweep.newRecords.length).toBe(arrivedDuringPass);
  });

  test("AT2 — replay of the 2026-08-10 bare-entity-ref pass: read 93, ack 99, watermark 93", () => {
    const token = buildReviewToken([causalResultAt(93)], ISSUED_AT);
    const ackResults = [causalResultAt(99)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});
    const updated = advanceWatermarks(
      {},
      ackResults,
      ackable,
      ACKED_AT,
      reconciliation.reviewedCounts
    );

    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedCount).toBe(93);
    // AT4 — the six records the ack declined to advance over are NAMED, not
    // left for a later sweep to reveal.
    expect(reconciliation.midPassArrivals).toEqual([{ path: CAUSAL_ENTRY.path, count: 6 }]);
  });

  test("AT4 — no mid-pass arrivals are reported when the log did not grow", () => {
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(11)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );
    expect(reconciliation.midPassArrivals).toEqual([]);
  });

  test("AT3 — a count larger than the log is REJECTED, and no count is produced", () => {
    // Only reachable from a token issued against a different tree or a rotated
    // log; writing it would mark not-yet-existing records as reviewed.
    const token = buildReviewToken([causalResultAt(50)], ISSUED_AT);
    expect(() =>
      reconcileReviewReceipt(
        parseReviewToken(token),
        [causalResultAt(20)],
        new Set([CAUSAL_ENTRY.path]),
        {}
      )
    ).toThrow(InvalidReviewTokenError);
  });

  test("AT3 — a stale count below the existing watermark is clamped UP, never written through", () => {
    const token = buildReviewToken([causalResultAt(5)], ISSUED_AT);
    const watermarks: WatermarkStore = {
      [CAUSAL_ENTRY.path]: { lastReviewedCount: 12, lastReviewedAt: "2026-08-09T00:00:00Z" },
    };
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(20)],
      new Set([CAUSAL_ENTRY.path]),
      watermarks
    );
    expect(reconciliation.reviewedCounts[CAUSAL_ENTRY.path]).toBe(12);
    expect(reconciliation.clampedPaths).toEqual([CAUSAL_ENTRY.path]);
    // The tail is measured from the clamped count, not from the stale one.
    expect(reconciliation.midPassArrivals).toEqual([{ path: CAUSAL_ENTRY.path, count: 8 }]);
  });

  test("AT3 — a malformed or tampered token is rejected", () => {
    expect(() => parseReviewToken("not-a-token")).toThrow(InvalidReviewTokenError);
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT);
    const [payload] = token.split(".") as [string, string];
    expect(() => parseReviewToken(`${payload}.deadbeefdeadbeef`)).toThrow(InvalidReviewTokenError);
  });

  test("a log the receipt does not cover is NOT advanced", () => {
    // The receipt was issued before this log existed in the swept set, so
    // nothing is known about what was classified in it.
    const token = buildReviewToken([], ISSUED_AT);
    const ackResults = [causalResultAt(11)];
    const ackable = new Set([CAUSAL_ENTRY.path]);
    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});

    expect(reconciliation.unreceiptedPaths).toEqual([CAUSAL_ENTRY.path]);
    expect(reconciliation.reviewedCounts).toEqual({});

    const updated = advanceWatermarks(
      {},
      ackResults,
      ackable,
      ACKED_AT,
      reconciliation.reviewedCounts
    );
    expect(updated[CAUSAL_ENTRY.path]).toBeUndefined();
  });

  test("only ackable paths are reconciled", () => {
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(20)],
      new Set(),
      {}
    );
    expect(reconciliation.reviewedCounts).toEqual({});
    expect(reconciliation.midPassArrivals).toEqual([]);
    expect(reconciliation.unreceiptedPaths).toEqual([]);
  });
});
