/**
 * mt#4941 — a STRANDED watermark is repaired by the ack, not clamped back up.
 *
 * mt#4904 shipped the `watermark-stranded` review-due leg and recorded that the
 * strand would "self-repair through the normal review flow." It did not: the
 * ack's backwards-move clamp raises any receipt count sitting below the
 * existing watermark, which is every stranded log by definition, so the ack
 * preserved the exact value it was supposed to clear. 13 logs sat permanently
 * review-due with `firesSinceLastReview: 0` and no in-tool action that could
 * clear them.
 *
 * Kept out of `calibration-review-receipt.test.ts` (449 lines) and
 * `calibration-sweep.test.ts` (at the 1500-line `max-lines` ceiling) for the
 * same reason mt#3179 split the review-due block out. Pure in-memory data, no
 * filesystem I/O; the clock is injected everywhere it is read.
 */

import { describe, test, expect } from "bun:test";
import {
  advanceWatermarks,
  buildReviewToken,
  computeLogResult,
  computeReviewDueLogs,
  parseReviewToken,
  reconcileReviewReceipt,
  type CalibrationLogEntry,
  type LogWatermark,
  type WatermarkStore,
} from "./calibration-sweep";

const STRANDED_REASON = "watermark-stranded";
const ISSUED_AT = "2026-09-04T07:31:00Z";
const ACKED_AT = "2026-09-04T07:32:00Z";
const ACKED_AT_MS = Date.parse(ACKED_AT);

function entryFor(name: string): CalibrationLogEntry {
  return { path: `.minsky/${name}-calibration.jsonl`, name, kind: "causal-premise" };
}

function record(i: number): string {
  return JSON.stringify({
    timestamp: "2026-09-04T07:00:00Z",
    session_id: "test-session",
    matchedPhrases: [`p${i}`],
    hadSameTurnVerification: false,
  });
}

/** A sweep result for `entry` holding exactly `count` records. */
function resultAt(entry: CalibrationLogEntry, count: number, watermark?: LogWatermark) {
  const lines = Array.from({ length: count }, (_, i) => record(i)).join("\n");
  return computeLogResult(entry, lines, true, watermark);
}

function watermarkAt(count: number, at: string = "2026-09-01T00:00:00Z"): LogWatermark {
  return { lastReviewedCount: count, lastReviewedAt: at };
}

describe("stranded-watermark repair (mt#4941)", () => {
  test("AT1 — an ack clears the strand and leaves the live records unreviewed", () => {
    // `code-mechanism-assertion` as measured 2026-09-04T07:31Z: watermark 1362
    // against 163 live records. The receipt necessarily carries the LIVE count,
    // because that is what the sweep observed.
    const entry = entryFor("code-mechanism-assertion");
    const stranded = watermarkAt(1362);
    const watermarks: WatermarkStore = { [entry.path]: stranded };

    const results = [resultAt(entry, 163, stranded)];
    expect(results[0]?.watermarkStranded).toBe(true);
    // Precondition: the log IS review-due, and for the stranded reason — so a
    // pass reaches the ack at all.
    const dueBefore = computeReviewDueLogs(results, watermarks, ACKED_AT_MS);
    expect(dueBefore.find((d) => d.path === entry.path)?.reason).toBe(STRANDED_REASON);

    const token = buildReviewToken(results, ISSUED_AT, [entry.path]);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      results,
      new Set([entry.path]),
      watermarks
    );

    // Pre-fix this wrote 1362 and named the path in `clampedPaths`.
    //
    // 0, NOT the receipt's 163: a stranded sweep sets `firesSinceLastReview` to
    // 0 and `newRecords` to [], so the reviewer was shown nothing and none of
    // the 163 has been classified. Writing 163 would mark them all reviewed by
    // nobody — the mt#3906 defect the receipt exists to prevent.
    expect(reconciliation.reviewedCounts[entry.path]).toBe(0);
    expect(reconciliation.repairedPaths).toEqual([entry.path]);
    expect(reconciliation.clampedPaths).toEqual([]);
    // Nor are the restored records a mid-pass arrival — nothing arrived.
    expect(reconciliation.midPassArrivals).toEqual([]);

    const updated = advanceWatermarks(
      watermarks,
      results,
      new Set([entry.path]),
      ACKED_AT,
      reconciliation.reviewedCounts
    );
    expect(updated[entry.path]?.lastReviewedCount).toBe(0);

    // The property that actually matters, checked end-to-end against the next
    // sweep rather than inferred from the stored number: the strand is gone,
    // and the log is due again for a REAL reason with its records in hand.
    const nextSweep = [resultAt(entry, 163, updated[entry.path])];
    expect(nextSweep[0]?.watermarkStranded).toBe(false);
    expect(nextSweep[0]?.firesSinceLastReview).toBe(163);
    expect(nextSweep[0]?.newRecords.length).toBe(163);
    const dueAfter = computeReviewDueLogs(nextSweep, updated, ACKED_AT_MS);
    expect(dueAfter.find((d) => d.path === entry.path)?.reason).not.toBe(STRANDED_REASON);
  });

  test("AT2 — a genuinely stale token is still clamped, and is NOT reported as a repair", () => {
    // The protection this fix must keep: watermark 100 against a log holding
    // 200, with a receipt claiming only 50. Not stranded (100 < 200), so the
    // 50 records between 50 and 100 were legitimately reviewed by an earlier
    // pass and must not be re-opened.
    const entry = entryFor("silent-stretch");
    const watermarks: WatermarkStore = { [entry.path]: watermarkAt(100) };

    const readResults = [resultAt(entry, 50)];
    const token = buildReviewToken(readResults, ISSUED_AT, [entry.path]);

    const ackResults = [resultAt(entry, 200, watermarks[entry.path])];
    expect(ackResults[0]?.watermarkStranded).toBe(false);

    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      ackResults,
      new Set([entry.path]),
      watermarks
    );

    expect(reconciliation.reviewedCounts[entry.path]).toBe(100);
    expect(reconciliation.clampedPaths).toEqual([entry.path]);
    expect(reconciliation.repairedPaths).toEqual([]);
  });

  test("the two dispositions are disjoint — one ack, one stranded log and one stale token", () => {
    // Both arrive on the SAME condition (`receiptCount < watermarkCount`), so a
    // fix that split them wrongly would still pass each single-log test above.
    const strandedEntry = entryFor("wall-of-text");
    const staleEntry = entryFor("untaken-action");
    const watermarks: WatermarkStore = {
      [strandedEntry.path]: watermarkAt(641),
      [staleEntry.path]: watermarkAt(100),
    };

    const readResults = [resultAt(strandedEntry, 112), resultAt(staleEntry, 50)];
    const token = buildReviewToken(readResults, ISSUED_AT, [strandedEntry.path, staleEntry.path]);

    const ackResults = [
      resultAt(strandedEntry, 112, watermarks[strandedEntry.path]),
      resultAt(staleEntry, 200, watermarks[staleEntry.path]),
    ];

    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      ackResults,
      new Set([strandedEntry.path, staleEntry.path]),
      watermarks
    );

    expect(reconciliation.repairedPaths).toEqual([strandedEntry.path]);
    expect(reconciliation.clampedPaths).toEqual([staleEntry.path]);
    // Opposite directions from the same starting condition: the strand resets
    // to 0, the stale token is raised to the watermark it predates.
    expect(reconciliation.reviewedCounts[strandedEntry.path]).toBe(0);
    expect(reconciliation.reviewedCounts[staleEntry.path]).toBe(100);
  });

  test("AT4 — replay of the live condition: 13 stranded logs, one ack, all 13 repaired", () => {
    // Watermark / live-record pairs measured from the read-only sweep at
    // 2026-09-04T07:31Z — the same 13 logs mt#4904 measured on 2026-09-03 and
    // this spec re-measured at 04:09Z, with the corpora grown and the
    // watermarks unmoved.
    const measured = (
      [
        ["ask-routing-deferral", 548, 50],
        ["bare-entity-ref", 2130, 475],
        ["causal-premise", 5, 1],
        ["code-mechanism-assertion", 1362, 163],
        ["constructed-identifier-batch", 24, 2],
        ["knowledge-acquisition", 251, 14],
        ["operator-deferral", 186, 33],
        ["pre-narration", 1086, 154],
        ["retrospective-trigger", 2338, 249],
        ["silent-stretch", 185, 13],
        ["stop-at-decision", 47, 9],
        ["untaken-action", 424, 175],
        ["wall-of-text", 641, 112],
      ] as [string, number, number][]
    ).map(([name, watermark, live]) => ({ entry: entryFor(name), watermark, live }));
    expect(measured.length).toBe(13);

    const watermarks: WatermarkStore = {};
    for (const m of measured) watermarks[m.entry.path] = watermarkAt(m.watermark);

    const results = measured.map((m) => resultAt(m.entry, m.live, watermarks[m.entry.path]));
    // Every one is stranded, and every one reports zero reviewable fires —
    // which is what makes the strand invisible without this field.
    expect(results.every((r) => r.watermarkStranded)).toBe(true);
    expect(results.every((r) => r.firesSinceLastReview === 0)).toBe(true);

    const paths = measured.map((m) => m.entry.path);
    const token = buildReviewToken(results, ISSUED_AT, paths);
    const reconciliation = reconcileReviewReceipt(
      parseReviewToken(token),
      results,
      new Set(paths),
      watermarks
    );

    expect(reconciliation.repairedPaths.sort()).toEqual([...paths].sort());
    expect(reconciliation.clampedPaths).toEqual([]);

    const updated = advanceWatermarks(
      watermarks,
      results,
      new Set(paths),
      ACKED_AT,
      reconciliation.reviewedCounts
    );

    // Every watermark is reset, no strand survives, and the whole corpus is
    // back in the queue rather than written off: 1,450 records across the 13.
    for (const m of measured) {
      expect(updated[m.entry.path]?.lastReviewedCount).toBe(0);
    }
    const nextSweep = measured.map((m) => resultAt(m.entry, m.live, updated[m.entry.path]));
    expect(nextSweep.some((r) => r.watermarkStranded)).toBe(false);
    expect(nextSweep.reduce((n, r) => n + r.firesSinceLastReview, 0)).toBe(
      measured.reduce((n, m) => n + m.live, 0)
    );
    const dueAfter = computeReviewDueLogs(nextSweep, updated, ACKED_AT_MS);
    expect(dueAfter.some((d) => d.reason === STRANDED_REASON)).toBe(false);
  });
});
