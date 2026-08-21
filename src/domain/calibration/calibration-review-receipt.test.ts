/**
 * Unit tests for the review-receipt half of the calibration sweep (mt#3906).
 *
 * Kept out of `calibration-sweep.test.ts` because that file already sits at the
 * 1500-line cap; all tests here operate on in-memory data, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "crypto";
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
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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

    const token = buildReviewToken([causalResultAt(readCount)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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
    const token = buildReviewToken([causalResultAt(93)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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
    const token = buildReviewToken([causalResultAt(50)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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
    const token = buildReviewToken([causalResultAt(5)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT, [CAUSAL_ENTRY.path]);
    const [payload] = token.split(".") as [string, string];
    expect(() => parseReviewToken(`${payload}.deadbeefdeadbeef`)).toThrow(InvalidReviewTokenError);
  });

  test("a log the receipt does not cover is NOT advanced", () => {
    // The receipt was issued before this log existed in the swept set, so
    // nothing is known about what was classified in it.
    const token = buildReviewToken([], ISSUED_AT, []);
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
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT, [CAUSAL_ENTRY.path]);
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

/**
 * mt#4391 — the receipt bounds WHICH logs an ack may advance, not only how far.
 *
 * The scenario every test here encodes is the measured 2026-08-21 incident: a
 * log sitting just below the count bar at sweep time, one record arriving
 * mid-pass, and the ack then advancing a backlog nobody classified.
 */
describe("review receipts — the review-due set (mt#4391)", () => {
  /** A token from a sweep that SAW the log and did not present it as due. */
  function tokenSweptButNotDue(count: number): string {
    return buildReviewToken([causalResultAt(count)], ISSUED_AT, []);
  }

  test("AT1 — a log that became review-due after the token was issued is NOT advanced, and is named", () => {
    // The wall-of-text shape: one under the bar at sweep time, over it by ack.
    const atSweep = FIRES_THRESHOLD - 1;
    const atAck = FIRES_THRESHOLD;

    const token = tokenSweptButNotDue(atSweep);
    const ackResults = [causalResultAt(atAck)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});

    expect(reconciliation.newlyDuePaths).toEqual([CAUSAL_ENTRY.path]);
    // Nothing to write — which is the whole point. Pre-mt#4391 this produced a
    // count of `atSweep` and marked the entire backlog reviewed.
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

  test("AT1 — the skipped log is still fully review-due on the NEXT sweep", () => {
    // The skip must not cost the records either; they are deferred, not lost.
    const atAck = FIRES_THRESHOLD;
    const token = tokenSweptButNotDue(FIRES_THRESHOLD - 1);
    const ackResults = [causalResultAt(atAck)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});
    const updated = advanceWatermarks(
      {},
      ackResults,
      ackable,
      ACKED_AT,
      reconciliation.reviewedCounts
    );

    const nextSweep = causalResultAt(atAck, updated[CAUSAL_ENTRY.path]);
    expect(nextSweep.firesSinceLastReview).toBe(atAck);
    expect(nextSweep.atCountThreshold).toBe(true);
  });

  test("AT2 — negative control: a log that WAS due at mint time still advances, tail still reported", () => {
    // Identical shape to AT1 except the token records the log as due. If this
    // fails, the gate is over-broad and has stopped acking legitimate reviews.
    const readCount = FIRES_THRESHOLD;
    const ackCount = readCount + 4;

    const token = buildReviewToken([causalResultAt(readCount)], ISSUED_AT, [CAUSAL_ENTRY.path]);
    const ackResults = [causalResultAt(ackCount)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});

    expect(reconciliation.newlyDuePaths).toEqual([]);
    expect(reconciliation.reviewedCounts[CAUSAL_ENTRY.path]).toBe(readCount);
    expect(reconciliation.midPassArrivals).toEqual([{ path: CAUSAL_ENTRY.path, count: 4 }]);
  });

  test("AT3 — nothing is advanced when every ackable path is newly due", () => {
    // The domain half of `watermarkAdvanced`'s honesty: the adapter gates its
    // write on `Object.keys(reviewedCounts)`, so an empty set means the write
    // block never runs and the flag stays false.
    const token = tokenSweptButNotDue(3);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(20)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );
    expect(Object.keys(reconciliation.reviewedCounts)).toEqual([]);
    expect(reconciliation.newlyDuePaths).toEqual([CAUSAL_ENTRY.path]);
  });

  test("AT4 — the field is present-and-empty on an uncontended pass, not absent", () => {
    const token = buildReviewToken([causalResultAt(11)], ISSUED_AT, [CAUSAL_ENTRY.path]);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(11)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );
    // `toEqual([])` alone would also pass on `undefined` in some matchers, so
    // assert the key exists as its own claim.
    expect("newlyDuePaths" in reconciliation).toBe(true);
    expect(reconciliation.newlyDuePaths).toEqual([]);
  });

  test("an unswept log stays `unreceipted` rather than being relabelled newly-due", () => {
    // Ordering guard. Absent from `counts` is the more fundamental condition —
    // the sweep never saw the log at all — and must not be reported as the
    // milder "saw it, wasn't due".
    const token = buildReviewToken([], ISSUED_AT, []);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(11)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );
    expect(reconciliation.unreceiptedPaths).toEqual([CAUSAL_ENTRY.path]);
    expect(reconciliation.newlyDuePaths).toEqual([]);
  });

  test("a token predating mt#4391 is REJECTED, not silently treated as all-ackable", () => {
    // Hand-build a legacy payload: `issuedAt` + `counts`, no `reviewDue`. The
    // checksum is recomputed so this fails on the MISSING FIELD and not on
    // tampering — otherwise the test would pass for the wrong reason.
    const legacyJson = JSON.stringify({
      issuedAt: ISSUED_AT,
      counts: { [CAUSAL_ENTRY.path]: 11 },
    });
    const payload = Buffer.from(legacyJson, "utf8").toString("base64url");
    const checksum = createHash("sha256").update(legacyJson).digest("hex").slice(0, 16);

    expect(() => parseReviewToken(`${payload}.${checksum}`)).toThrow(InvalidReviewTokenError);
    expect(() => parseReviewToken(`${payload}.${checksum}`)).toThrow(/reviewDue/);
  });

  test("PR #3214 R1 — a claim-held log is skipped under its OWN reason, not mislabelled newly-due", () => {
    // Due at mint time, withheld because another pass held a claim. The skill
    // tells the reviewer to stand down on it, so nothing was classified.
    const token = buildReviewToken([causalResultAt(20)], ISSUED_AT, [], [CAUSAL_ENTRY.path]);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(20)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );

    expect(reconciliation.claimHeldPaths).toEqual([CAUSAL_ENTRY.path]);
    // The label is the point: it did NOT cross a threshold during the pass.
    expect(reconciliation.newlyDuePaths).toEqual([]);
  });

  test("PR #3214 R1 — a claim-held log is still NOT advanced", () => {
    // The disposition must not change with the label. The review's first
    // suggested fix (mint `reviewDue` from the unfiltered due set) would have
    // advanced this path — marking reviewed a log nobody read, which is the
    // defect mt#4391 exists to close. This test is what would catch that.
    const token = buildReviewToken([causalResultAt(20)], ISSUED_AT, [], [CAUSAL_ENTRY.path]);
    const ackResults = [causalResultAt(20)];
    const ackable = new Set([CAUSAL_ENTRY.path]);

    const reconciliation = reconcileReviewReceipt(parseReviewToken(token), ackResults, ackable, {});
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

  test("PR #3214 R1 — a log that is BOTH shown and claim-held resolves as shown", () => {
    // Cannot arise from the adapter (the two sets are disjoint by
    // construction), but the precedence must be defined rather than incidental:
    // being presented to the reviewer means it WAS classified.
    const token = buildReviewToken(
      [causalResultAt(20)],
      ISSUED_AT,
      [CAUSAL_ENTRY.path],
      [CAUSAL_ENTRY.path]
    );
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      [causalResultAt(20)],
      new Set([CAUSAL_ENTRY.path]),
      {}
    );
    expect(reconciliation.reviewedCounts[CAUSAL_ENTRY.path]).toBe(20);
    expect(reconciliation.claimHeldPaths).toEqual([]);
    expect(reconciliation.newlyDuePaths).toEqual([]);
  });

  test("the checksum does not depend on the order reviewDue was built in", () => {
    const other = ".minsky/wall-of-text-calibration.jsonl";
    const results = [causalResultAt(11)];
    const a = buildReviewToken(results, ISSUED_AT, [CAUSAL_ENTRY.path, other]);
    const b = buildReviewToken(results, ISSUED_AT, [other, CAUSAL_ENTRY.path]);
    expect(a).toBe(b);
    expect(parseReviewToken(a).reviewDue).toEqual([CAUSAL_ENTRY.path, other].sort());
  });
});
