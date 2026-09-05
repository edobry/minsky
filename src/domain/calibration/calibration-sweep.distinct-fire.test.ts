/**
 * mt#3866 AT2 + AT4 — the sweep's distinct-fire reporting.
 *
 * AT2: *"The sweep reports raw record count and distinct-fire count as separate
 * figures for a log containing known duplicates."*
 * AT4: *"A record written before this change is reported as un-groupable, not
 * silently counted as distinct."*
 *
 * Records are built by PARSING real JSONL through `parseCalibrationLines`, not
 * by hand-constructing `CalibrationRecord` objects. That is deliberate: the
 * defect being guarded against depends on WHICH RECORD LEVEL the digest lands
 * at, and `ask-routing-deferral` has no per-kind parse branch, so its digest is
 * demoted into `detectorFields`. A hand-built fixture would put the field
 * wherever the test author expected it and pass whether or not the production
 * reader looks in the right place — mem#827's two-level trap, reproduced in a
 * test instead of in a review.
 */
import { describe, test, expect } from "bun:test";

import { countDistinctFires, distinctFireFields, parseCalibrationLines } from "./calibration-sweep";

const KIND = "ask-routing-deferral" as const;

/**
 * The digest from the measured incident — `causal-premise-evaluations.jsonl`
 * reported this value on all three records of the 2026-08-16 group, which is
 * how mt#3866 `## Evidence 2026-08-16` established re-scan rather than repeat
 * authoring. Reused here so the fixtures carry the real shape.
 */
const SHARED_DIGEST = "a698ea3cbbbdc11c";

/** One record as the detector actually writes it, post-mt#3866. */
function record(opts: { timestamp: string; hash?: string; context?: string }): string {
  return JSON.stringify({
    timestamp: opts.timestamp,
    session_id: "131d7153-0000-4000-8000-000000000000",
    injection_enabled: true,
    captureSchema: 1,
    ...(opts.hash !== undefined ? { judged_text_hash: opts.hash } : {}),
    matches: [
      {
        class: "principal-reserved",
        phrase: "you decide",
        context: opts.context ?? "…before you decide.",
      },
    ],
    suppressionReasons: [],
  });
}

describe("mt#3866 AT2 — raw and distinct are separate figures", () => {
  test("four records of ONE judged message report 4 raw, 1 distinct", () => {
    // The measured shape: 2026-09-04T16:57–16:59, four records, byte-identical
    // context, one message re-scanned. Before this change the sweep had no way
    // to say anything but "4".
    const lines = [
      record({ timestamp: "2026-09-04T16:57:19.553Z", hash: SHARED_DIGEST }),
      record({ timestamp: "2026-09-04T16:58:26.797Z", hash: SHARED_DIGEST }),
      record({ timestamp: "2026-09-04T16:59:05.099Z", hash: SHARED_DIGEST }),
      record({ timestamp: "2026-09-04T16:59:33.057Z", hash: SHARED_DIGEST }),
    ].join("\n");

    const records = parseCalibrationLines(lines, KIND);
    expect(records).toHaveLength(4);

    const { distinct, ungroupable } = countDistinctFires(records);
    expect(distinct).toBe(1);
    expect(ungroupable).toBe(0);
  });

  test("four records of FOUR judged messages report 4 raw, 4 distinct", () => {
    // The control that makes the assertion above evidence rather than a
    // constant: same count, same shape, different digests.
    const lines = [
      record({ timestamp: "2026-09-04T16:57:19.553Z", hash: "1111111111111111" }),
      record({ timestamp: "2026-09-04T16:58:26.797Z", hash: "2222222222222222" }),
      record({ timestamp: "2026-09-04T16:59:05.099Z", hash: "3333333333333333" }),
      record({ timestamp: "2026-09-04T16:59:33.057Z", hash: "4444444444444444" }),
    ].join("\n");

    const { distinct, ungroupable } = countDistinctFires(parseCalibrationLines(lines, KIND));
    expect(distinct).toBe(4);
    expect(ungroupable).toBe(0);
  });

  test("the digest is read out of `detectorFields`, where this kind's parse puts it", () => {
    // Pins the level. `ask-routing-deferral` has no per-kind branch, so the
    // digest is demoted into the passthrough; a reader checking only the top
    // level would report every record un-groupable and this test would fail.
    const [parsed] = parseCalibrationLines(
      record({ timestamp: "2026-09-04T16:57:19.553Z", hash: SHARED_DIGEST }),
      KIND
    );
    const passthrough = (parsed as unknown as { detectorFields?: Record<string, unknown> })
      .detectorFields;
    expect(passthrough?.["judged_text_hash"]).toBe(SHARED_DIGEST);
  });
});

describe("mt#3866 AT4 — pre-change records are un-groupable, not distinct", () => {
  test("records with no digest land in the un-groupable column and NOT in distinct", () => {
    const lines = [
      record({ timestamp: "2026-09-04T16:57:19.553Z" }),
      record({ timestamp: "2026-09-04T16:58:26.797Z" }),
      record({ timestamp: "2026-09-04T16:59:05.099Z" }),
    ].join("\n");

    const { distinct, ungroupable } = countDistinctFires(parseCalibrationLines(lines, KIND));

    // The failure this guards: `distinct === 3`, i.e. absence read as identity.
    expect(distinct).toBe(0);
    expect(ungroupable).toBe(3);
  });

  test("a mixed window reports both columns, bounding the true count to a range", () => {
    // 5 records: 2 share a digest, 1 has its own, 2 carry none. Distinct is 2
    // and un-groupable is 2, so a reader knows the true distinct count is in
    // [2, 4] — which is the statement a single figure cannot make.
    const lines = [
      record({ timestamp: "2026-09-04T16:57:19.553Z", hash: "aaaaaaaaaaaaaaaa" }),
      record({ timestamp: "2026-09-04T16:58:26.797Z", hash: "aaaaaaaaaaaaaaaa" }),
      record({ timestamp: "2026-09-04T16:59:05.099Z", hash: "bbbbbbbbbbbbbbbb" }),
      record({ timestamp: "2026-09-04T17:00:05.099Z" }),
      record({ timestamp: "2026-09-04T17:01:05.099Z" }),
    ].join("\n");

    const { distinct, ungroupable } = countDistinctFires(parseCalibrationLines(lines, KIND));
    expect(distinct).toBe(2);
    expect(ungroupable).toBe(2);
  });
});

describe("mt#3866 — distinctFireFields maps to the result's own field names", () => {
  test("production and fixtures share one derivation", () => {
    const records = parseCalibrationLines(
      [
        record({ timestamp: "2026-09-04T16:57:19.553Z", hash: "cccccccccccccccc" }),
        record({ timestamp: "2026-09-04T16:58:26.797Z", hash: "cccccccccccccccc" }),
        record({ timestamp: "2026-09-04T16:59:05.099Z" }),
      ].join("\n"),
      KIND
    );

    expect(distinctFireFields(records)).toEqual({
      distinctFiresSinceLastReview: 1,
      ungroupableSinceLastReview: 1,
    });
  });

  test("an empty window is 0/0 — nothing to group, and nothing un-groupable", () => {
    expect(distinctFireFields([])).toEqual({
      distinctFiresSinceLastReview: 0,
      ungroupableSinceLastReview: 0,
    });
  });
});
