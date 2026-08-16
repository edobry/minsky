import { describe, expect, test } from "bun:test";
import { CANARY_SESSION_ID } from "../.minsky/hooks/canary-runner";
import {
  measure,
  parseStream,
  type EvaluationRecord,
  type Label,
} from "./measure-causal-premise-fn-rate";

type RecordOverrides = Partial<Omit<EvaluationRecord, "judgedInput">> & {
  hash: string;
  judgedInput?: Partial<EvaluationRecord["judgedInput"]>;
};

function record(overrides: RecordOverrides): EvaluationRecord {
  const { hash, judgedInput, ...rest } = overrides;
  return {
    timestamp: "2026-08-14T00:00:00.000Z",
    session_id: "real-session",
    fired: false,
    matchedPhrases: [],
    hadSameTurnVerification: true,
    captureSchema: 1,
    ...rest,
    judgedInput: { excerpt: "text", hash, length: 100, truncated: false, ...judgedInput },
  };
}

function labels(entries: Record<string, Label>): { labels: Record<string, Label> } {
  return { labels: entries };
}

describe("denominator exclusions", () => {
  test("canary rows are excluded, keyed on session_id rather than a substring", () => {
    const records = [
      record({ hash: "a" }),
      record({ hash: "b", session_id: CANARY_SESSION_ID }),
      // Mentions "canary" in its text but is real traffic — a substring search
      // would wrongly drop this one (mt#4127).
      record({ hash: "c", judgedInput: { excerpt: "discussing the canary runner" } }),
    ];

    const result = measure(records);

    expect(result.canaryExcluded).toBe(1);
    expect(result.denominator).toBe(2);
  });

  test("empty-text rows are excluded — the detector returned before running any pattern", () => {
    const records = [
      record({ hash: "a" }),
      record({ hash: "b", judgedInput: { length: 0, excerpt: "" } }),
    ];

    const result = measure(records);

    expect(result.emptyTextExcluded).toBe(1);
    expect(result.denominator).toBe(1);
  });

  test("--until bounds the window so a rerun reproduces the counts as the stream grows", () => {
    const records = [
      record({ hash: "a", timestamp: "2026-08-14T00:00:00.000Z" }),
      record({ hash: "b", timestamp: "2026-08-15T00:00:00.000Z" }),
    ];

    const result = measure(records, { until: "2026-08-14T12:00:00.000Z" });

    expect(result.outsideWindowExcluded).toBe(1);
    expect(result.denominator).toBe(1);
  });
});

describe("stratification", () => {
  test("splits on hadSameTurnVerification, because an empty matchedPhrases means different things", () => {
    const records = [
      record({ hash: "a", hadSameTurnVerification: true }),
      record({ hash: "b", hadSameTurnVerification: true }),
      record({ hash: "c", hadSameTurnVerification: false }),
    ];

    const result = measure(records);

    expect(result.strata.suppressed.total).toBe(2);
    expect(result.strata.patternTested.total).toBe(1);
  });

  test("attributes a miss to the stratum it occurred in", () => {
    const records = [
      record({ hash: "supp", hadSameTurnVerification: true }),
      record({ hash: "pat", hadSameTurnVerification: false }),
    ];

    const result = measure(records, labels({ supp: "claim-unbacked", pat: "claim-backed" }));

    expect(result.strata.suppressed.falseNegatives).toBe(1);
    expect(result.strata.patternTested.falseNegatives).toBe(0);
    expect(result.rate.suppressed).toBe(1);
    expect(result.rate.patternTested).toBe(0);
  });
});

describe("rate computation", () => {
  test("indeterminate rows leave the base rather than counting as correct non-fires", () => {
    const records = [
      record({ hash: "a" }),
      record({ hash: "b" }),
      record({ hash: "c", judgedInput: { truncated: true } }),
    ];

    const result = measure(
      records,
      labels({ a: "claim-unbacked", b: "claim-backed", c: "indeterminate" })
    );

    // 1 of 2 resolved, NOT 1 of 3 — counting the truncated row as a correct
    // non-fire is the direction that flatters the detector.
    expect(result.rate.overall).toBe(0.5);
  });

  test("an unlabeled record contributes to the denominator but not to any rate", () => {
    const records = [record({ hash: "a" }), record({ hash: "b" })];

    const result = measure(records, labels({ a: "claim-unbacked" }));

    expect(result.denominator).toBe(2);
    expect(result.strata.suppressed.labeled).toBe(1);
    expect(result.rate.overall).toBe(1);
  });

  test("no resolved labels yields no rate rather than a misleading zero", () => {
    const result = measure([record({ hash: "a" })]);

    expect(result.rate.overall).toBeUndefined();
    expect(result.distinct.rate).toBeUndefined();
  });
});

describe("distinct-text counting", () => {
  test("a text evaluated twice votes once per distinct text and twice per record", () => {
    const records = [
      record({ hash: "dup", timestamp: "2026-08-14T00:00:00.000Z" }),
      record({ hash: "dup", timestamp: "2026-08-15T00:00:00.000Z" }),
      record({ hash: "other" }),
    ];

    const result = measure(records, labels({ dup: "claim-unbacked", other: "claim-backed" }));

    expect(result.denominator).toBe(3);
    expect(result.strata.suppressed.falseNegatives).toBe(2);
    expect(result.rate.overall).toBeCloseTo(2 / 3, 10);

    expect(result.distinct.texts).toBe(2);
    expect(result.distinct.falseNegatives).toBe(1);
    expect(result.distinct.rate).toBe(0.5);
  });
});

describe("field coverage", () => {
  test("counts records carrying every field, so a mid-log addition is visible", () => {
    const full = record({ hash: "a" });
    const partial = { ...record({ hash: "b" }) } as Partial<EvaluationRecord>;
    delete partial.hadSameTurnVerification;

    const result = measure([full, partial as EvaluationRecord]);

    expect(result.fieldCoverage.recordsWithAllFields).toBe(1);
  });
});

describe("parseStream", () => {
  test("skips blank lines and returns one record per JSON line", () => {
    const text = `${JSON.stringify(record({ hash: "a" }))}\n\n${JSON.stringify(record({ hash: "b" }))}\n`;

    expect(parseStream(text)).toHaveLength(2);
  });
});
