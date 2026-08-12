/**
 * Tests for `mergeWatermarkWrite` — the reconciliation that keeps one
 * calibration pass from silently reverting another's watermark write (mt#3899).
 *
 * Split out of `calibration-sweep.test.ts`, which is at the 1500-line ceiling.
 */
import { describe, test, expect } from "bun:test";
import { mergeWatermarkWrite, type LogWatermark, type WatermarkStore } from "./calibration-sweep";

// The originating incident: two agents ran a calibration pass over the same log
// inside four minutes. The store is read once, held across a multi-second sweep,
// then written back whole — so the second pass's ack was invisible to the first,
// and a whole-store write would have reverted it with no signal at all. These
// tests pin both halves of the fix: an unrelated concurrent entry survives, and
// a contested one is DROPPED-and-REPORTED rather than silently overwritten.

const PATH_A = ".minsky/a-calibration.jsonl";
const PATH_B = ".minsky/b-calibration.jsonl";
const AT_OLD = "2026-08-01T00:00:00.000Z";
const AT_NEW = "2026-08-10T00:00:00.000Z";
const AT_OTHER = "2026-08-09T00:00:00.000Z";
const TEST_ASK_ID = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";

const mark = (count: number, at: string, openAskId?: string): LogWatermark => ({
  lastReviewedCount: count,
  lastReviewedAt: at,
  ...(openAskId ? { openAskId } : {}),
});

describe("mergeWatermarkWrite (mt#3899)", () => {
  test("applies every intended edit when nothing changed underneath", () => {
    const base: WatermarkStore = { [PATH_A]: mark(10, AT_OLD) };
    const intended: WatermarkStore = { [PATH_A]: mark(42, AT_NEW) };

    const { merged, driftedPaths } = mergeWatermarkWrite(
      base,
      intended,
      { ...base },
      new Set([PATH_A])
    );

    expect(driftedPaths).toEqual([]);
    expect(merged[PATH_A]).toEqual(mark(42, AT_NEW));
  });

  test("drops and reports a target another pass advanced mid-sweep", () => {
    // This is the incident, reduced: pass A read count 40 and means to write 82;
    // pass B already wrote 82 with its own timestamp. Pass A's write must not
    // land, and pass A must be able to SEE that it did not.
    const base: WatermarkStore = { [PATH_A]: mark(40, AT_OLD) };
    const intended: WatermarkStore = { [PATH_A]: mark(82, AT_NEW) };
    const fresh: WatermarkStore = { [PATH_A]: mark(82, AT_OTHER) };

    const { merged, driftedPaths } = mergeWatermarkWrite(base, intended, fresh, new Set([PATH_A]));

    expect(driftedPaths).toEqual([PATH_A]);
    expect(merged[PATH_A]).toEqual(mark(82, AT_OTHER));
  });

  test("preserves an unrelated entry the concurrent pass wrote", () => {
    // The whole-store rewrite is what made this dangerous: PATH_B was not this
    // pass's business, and a stale-snapshot write would have reverted it.
    const base: WatermarkStore = { [PATH_A]: mark(10, AT_OLD) };
    const intended: WatermarkStore = { [PATH_A]: mark(20, AT_NEW) };
    const fresh: WatermarkStore = { [PATH_A]: mark(10, AT_OLD), [PATH_B]: mark(7, AT_OTHER) };

    const { merged, driftedPaths } = mergeWatermarkWrite(base, intended, fresh, new Set([PATH_A]));

    expect(driftedPaths).toEqual([]);
    expect(merged[PATH_A]).toEqual(mark(20, AT_NEW));
    expect(merged[PATH_B]).toEqual(mark(7, AT_OTHER));
  });

  test("treats an entry appearing under a never-reviewed target as drift", () => {
    // A never-reviewed log has no entry at all, so `absent -> present` is the
    // exact shape a concurrent first-ack takes. Comparing only field values
    // would miss it.
    const base: WatermarkStore = {};
    const intended: WatermarkStore = { [PATH_A]: mark(3, AT_NEW) };
    const fresh: WatermarkStore = { [PATH_A]: mark(3, AT_OTHER) };

    const { merged, driftedPaths } = mergeWatermarkWrite(base, intended, fresh, new Set([PATH_A]));

    expect(driftedPaths).toEqual([PATH_A]);
    expect(merged[PATH_A]?.lastReviewedAt).toBe(AT_OTHER);
  });

  test("counts an openAskId change alone as drift", () => {
    // Counts and timestamps can match while the ask binding differs — that is a
    // clear or a re-affirm by another pass, and it must not be overwritten.
    const base: WatermarkStore = { [PATH_A]: mark(10, AT_OLD, TEST_ASK_ID) };
    const intended: WatermarkStore = { [PATH_A]: mark(20, AT_NEW, TEST_ASK_ID) };
    const fresh: WatermarkStore = { [PATH_A]: mark(10, AT_OLD) };

    const { merged, driftedPaths } = mergeWatermarkWrite(base, intended, fresh, new Set([PATH_A]));

    expect(driftedPaths).toEqual([PATH_A]);
    expect(merged[PATH_A]).toEqual(mark(10, AT_OLD));
  });

  test("applies the clean targets of a partially-drifted pass", () => {
    // A mixed pass must not be all-or-nothing: losing one log's race is not a
    // reason to discard the work done on another.
    const base: WatermarkStore = { [PATH_A]: mark(10, AT_OLD), [PATH_B]: mark(5, AT_OLD) };
    const intended: WatermarkStore = { [PATH_A]: mark(20, AT_NEW), [PATH_B]: mark(9, AT_NEW) };
    const fresh: WatermarkStore = { [PATH_A]: mark(99, AT_OTHER), [PATH_B]: mark(5, AT_OLD) };

    const { merged, driftedPaths } = mergeWatermarkWrite(
      base,
      intended,
      fresh,
      new Set([PATH_A, PATH_B])
    );

    expect(driftedPaths).toEqual([PATH_A]);
    expect(merged[PATH_A]).toEqual(mark(99, AT_OTHER));
    expect(merged[PATH_B]).toEqual(mark(9, AT_NEW));
  });
});
