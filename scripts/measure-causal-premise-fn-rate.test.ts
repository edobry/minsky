import { describe, expect, test } from "bun:test";
import { CANARY_SESSION_ID } from "../.minsky/hooks/canary-runner";
import {
  measure,
  parseStream,
  render,
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

    const parsed = parseStream(text);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.malformedLines).toBe(0);
  });

  test("a malformed line is skipped and counted, not thrown on", () => {
    const text = [
      JSON.stringify(record({ hash: "a" })),
      '{"timestamp":"2026-08-14T00:00:00.000Z","judgedInp', // truncated write
      JSON.stringify(record({ hash: "b" })),
    ].join("\n");

    const parsed = parseStream(text);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.malformedLines).toBe(1);
  });

  test("the malformed count reaches the report rather than being swallowed", () => {
    const result = measure([record({ hash: "a" })], { malformedLines: 3 });

    expect(result.dataQuality.malformedLines).toBe(3);
  });
});

describe("timestamp handling", () => {
  test("windows chronologically, not lexicographically, across mixed zone forms", () => {
    const records = [
      // Same instant, three spellings that do NOT sort lexicographically:
      // an offset form, a no-millis form, and the canonical Z form. All three
      // are inside the window and must survive it.
      record({ hash: "offset", timestamp: "2026-08-14T00:00:00+00:00" }),
      record({ hash: "no-millis", timestamp: "2026-08-14T00:00:00Z" }),
      record({ hash: "canonical", timestamp: "2026-08-14T00:00:00.000Z" }),
    ];

    const result = measure(records, {
      since: "2026-08-13T00:00:00.000Z",
      until: "2026-08-15T00:00:00.000Z",
    });

    expect(result.outsideWindowExcluded).toBe(0);
    expect(result.denominator).toBe(3);
  });

  test("an offset-form bound is honored rather than string-compared", () => {
    const records = [
      record({ hash: "before", timestamp: "2026-08-14T09:00:00.000Z" }),
      record({ hash: "after", timestamp: "2026-08-14T11:00:00.000Z" }),
    ];

    // 06:00-04:00 == 10:00Z. A raw string comparison against "2026-08-14T06:00:00-04:00"
    // would place BOTH records after the bound and exclude neither.
    const result = measure(records, { until: "2026-08-14T06:00:00-04:00" });

    expect(result.outsideWindowExcluded).toBe(1);
    expect(result.denominator).toBe(1);
  });

  test("first/last window bounds are the chronological extremes, not the lexicographic ones", () => {
    // `+05:00` is the discriminating case, and a `-04:00` one is NOT: a minus
    // offset happens to sort the same way both ways, so a test built on it
    // passes against the lexicographic bug. Here "2026-08-14T12:00:00+05:00"
    // is 07:00Z — chronologically FIRST, lexicographically LAST — so both
    // bounds differ between the two orderings.
    const records = [
      record({ hash: "mid", timestamp: "2026-08-14T09:00:00.000Z" }),
      record({ hash: "latest", timestamp: "2026-08-14T10:00:00.000Z" }),
      record({ hash: "earliest", timestamp: "2026-08-14T12:00:00+05:00" }),
    ];

    const result = measure(records);

    expect(result.window.firstTimestamp).toBe("2026-08-14T12:00:00+05:00");
    expect(result.window.lastTimestamp).toBe("2026-08-14T10:00:00.000Z");
  });

  test("an unparseable record timestamp is excluded and counted, never silently compared", () => {
    const records = [record({ hash: "ok" }), record({ hash: "bad", timestamp: "not-a-date" })];

    const result = measure(records, { until: "2026-08-15T00:00:00.000Z" });

    expect(result.dataQuality.invalidTimestamps).toBe(1);
    expect(result.denominator).toBe(1);
  });
});

describe("verdict", () => {
  test("with no labels the bar is reported NOT EVALUATED, never as a pass", () => {
    const result = measure([record({ hash: "a" })]);

    expect(result.verdict.falseNegative).toBe("not-evaluated");
    expect(result.rate.overall).toBeUndefined();
    expect(render(result)).toContain("false-negative half: NOT EVALUATED");
  });

  test("a zero-fire window marks the false-positive half vacuous, not satisfied", () => {
    const result = measure([record({ hash: "a", fired: false })]);

    expect(result.fired).toBe(0);
    expect(result.verdict.falsePositive).toBe("vacuous-zero-fires");

    const text = render(result);
    expect(text).toContain("false-positive half: VACUOUS");
    expect(text).toContain("NOT evidence of precision");
  });

  test("a window with fires reports the false-positive half as not computed by this script", () => {
    const result = measure([record({ hash: "a", fired: true })]);

    expect(result.verdict.falsePositive).toBe("not-computed-by-this-script");
    expect(render(result)).toContain("false-positive half: NOT COMPUTED");
  });

  test("a rate above the bar reads NOT MET", () => {
    const records = [
      record({ hash: "a" }),
      record({ hash: "b" }),
      ...Array.from({ length: 18 }, (_, i) => record({ hash: `ok${i}` })),
    ];
    const entries: Record<string, Label> = { a: "claim-unbacked", b: "claim-backed" };
    for (let i = 0; i < 18; i += 1) entries[`ok${i}`] = "claim-backed";

    const result = measure(records, labels(entries));

    // 1 of 20 == 5%, exactly at the bar, which the bar admits ("<=5%").
    expect(result.rate.overall).toBe(0.05);
    expect(result.verdict.falseNegative).toBe("met");

    const over = measure([...records, record({ hash: "c" })], {
      labels: { ...entries, c: "claim-unbacked" },
    });
    expect(over.verdict.falseNegative).toBe("not-met");
    expect(render(over)).toContain("false-negative half: NOT MET");
  });
});
