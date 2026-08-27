/**
 * Unit tests for the operator rendering's derivation (mt#4287).
 *
 * The cases worth having are the ones where a plausible implementation is
 * wrong in a way that still renders: totals that double-count a
 * multi-class interceptor, an unavailable source folded into `working`, a
 * measured zero collapsed with an absent measurement, and an ordering that
 * quietly reverts to alphabetical or to check-count.
 */
import { describe, expect, test } from "bun:test";
import { deriveProtectionSummary, type ProtectionCatalogEntry } from "./protection-summary";
import type {
  CanaryStatusJoin,
  InterceptorAggregateRow,
  InterceptorAggregatesSnapshot,
} from "./aggregates";

function row(
  overrides: {
    guardName?: string;
    windowFires?: number;
    lifetimeFires?: number;
    deny?: number;
    warn?: number;
    canary?: CanaryStatusJoin | null;
    duration?: InterceptorAggregateRow["fireLog"]["window"]["duration"];
  } = {}
): InterceptorAggregateRow {
  const deny = overrides.deny ?? 0;
  const warn = overrides.warn ?? 0;
  return {
    guardName: overrides.guardName ?? "some-guard",
    fireLog: {
      window: {
        days: 7,
        fires: overrides.windowFires ?? deny + warn,
        byDecision: { allow: 0, warn, deny, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: overrides.duration ?? null,
      },
      lifetime: {
        totalFires: overrides.lifetimeFires ?? deny + warn,
        firstFireAt: null,
        lastFireAt: null,
      },
    },
    canary: overrides.canary === undefined ? { state: "passing" } : overrides.canary,
    health: null,
    calibration: null,
    registry: null,
  };
}

function snapshot(
  rows: InterceptorAggregateRow[],
  overrides: {
    declaredOnlyRows?: InterceptorAggregateRow[];
    sourceFailures?: string[];
  } = {}
): Pick<
  InterceptorAggregatesSnapshot,
  "rows" | "declaredOnlyRows" | "sourceFailures" | "windowDays" | "computedAt"
> {
  return {
    rows,
    declaredOnlyRows: overrides.declaredOnlyRows ?? [],
    sourceFailures: overrides.sourceFailures ?? [],
    windowDays: 7,
    computedAt: "2026-08-19T00:00:00.000Z",
  };
}

/** Class ids used across several cases — named so the fixtures cannot drift apart. */
const UNREVIEWED_MERGE = "unreviewed-merge";
/** The health kind, not the `CheckStatus` of the same spelling — see mt#4605. */
const SOURCE_UNAVAILABLE = "source-unavailable";

/**
 * First element, asserted present.
 *
 * These cases each construct exactly one class, so an empty list is a genuine
 * failure of the thing under test — surfacing it as a named error beats a
 * non-null assertion reporting `undefined.health`.
 */
function onlyClass<T>(items: T[]): T {
  if (items.length === 0) throw new Error("expected at least one class in the summary");
  return items[0] as T;
}

const QUESTIONS: Record<string, string> = {
  [UNREVIEWED_MERGE]: "What stops me merging something unreviewed?",
  "secret-exposure": "What stops a secret leaking into something permanent?",
  "lost-signal": "What makes sure I actually see what I need to see?",
};

describe("deriveProtectionSummary — totals", () => {
  test("an interceptor in THREE classes is counted once in totals and once per class", () => {
    // The failure this pins: summing the class rows to build the totals. That
    // implementation renders fine and reports 3x the real corpus cost.
    const entries: ProtectionCatalogEntry[] = [
      {
        guardName: "multi",
        failureClasses: [UNREVIEWED_MERGE, "secret-exposure", "lost-signal"],
      },
    ];
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "multi", deny: 5, warn: 2 })]),
      entries,
      QUESTIONS
    );

    expect(summary.totals.checkCount).toBe(1);
    expect(summary.totals.stopped).toBe(5);
    expect(summary.totals.flagged).toBe(2);
    expect(summary.totals.interruptions).toBe(7);

    // Each class still reports the full figure — the interceptor genuinely
    // protects against all three, so per-class is not a share-out.
    expect(summary.classes).toHaveLength(3);
    for (const c of summary.classes) {
      expect(c.checkCount).toBe(1);
      expect(c.ledger.interruptions).toBe(7);
    }
    // ...which is exactly why the naive sum would be 21.
    const naiveSum = summary.classes.reduce((n, c) => n + c.ledger.interruptions, 0);
    expect(naiveSum).toBe(21);
    expect(summary.totals.interruptions).not.toBe(naiveSum);
  });

  test("interruptions count denials and warnings only — allow and other are silent", () => {
    const r = row({ guardName: "g", deny: 3, warn: 4 });
    r.fireLog.window.byDecision.allow = 900;
    r.fireLog.window.byDecision.other = 50;
    r.fireLog.window.fires = 957;

    const summary = deriveProtectionSummary(
      snapshot([r]),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.totals.interruptions).toBe(7);
    expect(summary.totals.stopped).toBe(3);
    expect(summary.totals.flagged).toBe(4);
  });
});

describe("deriveProtectionSummary — indeterminate is never zero, never working, never conflated", () => {
  test("no measured duration yields timeMs null, NOT 0, with the fires recorded as unmeasured", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g", deny: 6, duration: null })]),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.totals.timeMs).toBeNull();
    expect(summary.totals.measuredFires).toBe(0);
    expect(summary.totals.unmeasuredFires).toBe(6);
  });

  test("MIXED measured/unmeasured rows: measured + unmeasured equals total fires exactly", () => {
    // The reviewer's BLOCKING finding on PR #3147 claimed the totals
    // double-count unmeasured fires in exactly this shape. Pinning the
    // invariant rather than arguing it: row A carries a duration (10 fires, 6
    // measured), row B carries none (5 fires). Correct is measured 6,
    // unmeasured (10-6)+5 = 9, summing to the 15 fires that exist. A
    // double-count would make unmeasured 19 (adding A's 10 again) or the sum
    // exceed 15.
    const withDuration = row({
      guardName: "measured",
      windowFires: 10,
      deny: 10,
      duration: { avgMs: 5, p95Ms: 8, maxMs: 9, totalMs: 30, measuredFires: 6 },
    });
    const withoutDuration = row({
      guardName: "unmeasured",
      windowFires: 5,
      deny: 5,
      duration: null,
    });

    const summary = deriveProtectionSummary(
      snapshot([withDuration, withoutDuration]),
      [
        { guardName: "measured", failureClasses: ["lost-signal"] },
        { guardName: "unmeasured", failureClasses: ["lost-signal"] },
      ],
      QUESTIONS
    );

    const { measuredFires, unmeasuredFires, timeMs } = summary.totals;
    expect(measuredFires).toBe(6);
    expect(unmeasuredFires).toBe(9);
    expect(measuredFires + unmeasuredFires).toBe(15);
    expect(timeMs).toBe(30);

    // Same invariant on the class row, which shares the accumulator.
    const cls = onlyClass(summary.classes);
    expect(cls.ledger.measuredFires + cls.ledger.unmeasuredFires).toBe(15);
  });

  test("the denominator invariant survives a partially-measured guard in THREE classes", () => {
    // The other half of PR #3147 R1's requested coverage: mixed measurement AND
    // multi-class membership together, which is where a totals dedupe keyed on
    // names could plausibly disagree with the per-class rows.
    //
    // `multi` (20 fires, 12 measured) sits in three classes; `solo` (7 fires,
    // no duration) sits in one. Totals must see 12 measured + (8 + 7) = 27, the
    // sum of fires over the DISTINCT set — not 20 counted three times.
    const summary = deriveProtectionSummary(
      snapshot([
        row({
          guardName: "multi",
          windowFires: 20,
          deny: 20,
          duration: { avgMs: 3, p95Ms: 6, maxMs: 9, totalMs: 36, measuredFires: 12 },
        }),
        row({ guardName: "solo", windowFires: 7, deny: 7, duration: null }),
      ]),
      [
        {
          guardName: "multi",
          failureClasses: [UNREVIEWED_MERGE, "secret-exposure", "lost-signal"],
        },
        { guardName: "solo", failureClasses: ["lost-signal"] },
      ],
      QUESTIONS
    );

    const distinctFireSum = 20 + 7;
    expect(summary.totals.measuredFires).toBe(12);
    expect(summary.totals.unmeasuredFires).toBe(15);
    expect(summary.totals.measuredFires + summary.totals.unmeasuredFires).toBe(distinctFireSum);
    // "cannot exceed it" — the explicit wording of the review finding.
    expect(summary.totals.measuredFires + summary.totals.unmeasuredFires).toBeLessThanOrEqual(
      distinctFireSum
    );
    expect(summary.totals.checkCount).toBe(2);

    // Every per-class row satisfies the same invariant over ITS own row set.
    for (const cls of summary.classes) {
      const rowsInClass = cls.classId === "lost-signal" ? 20 + 7 : 20;
      expect(cls.ledger.measuredFires + cls.ledger.unmeasuredFires).toBe(rowsInClass);
    }
  });

  test("a measured zero is 0, distinguishable from the null above", () => {
    const summary = deriveProtectionSummary(
      snapshot([
        row({
          guardName: "g",
          deny: 6,
          duration: { avgMs: 0, p95Ms: 0, maxMs: 0, totalMs: 0, measuredFires: 6 },
        }),
      ]),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.totals.timeMs).toBe(0);
    expect(summary.totals.measuredFires).toBe(6);
    expect(summary.totals.unmeasuredFires).toBe(0);
  });

  test("a failed canary source is SOURCE-UNAVAILABLE, not working and not never-verified", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g", canary: { state: "passing" } })], {
        sourceFailures: ["canary"],
      }),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.health.kind).toBe(SOURCE_UNAVAILABLE);
    expect(summary.health.sourceUnavailableCount).toBe(1);
    // The transient cause must not be reported as the permanent one — that
    // conflation is what mt#4605 exists to end.
    expect(summary.health.neverVerifiedCount).toBe(0);
    expect(onlyClass(summary.classes).health).toBe(SOURCE_UNAVAILABLE);
    expect(onlyClass(summary.classes).sourceUnavailableCount).toBe(1);
    expect(summary.health.degradedCount).toBe(0);
  });

  test("a never-verified check is NEVER-VERIFIED, not working and not source-unavailable", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g", canary: { state: "never-verified" } })]),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.health.kind).toBe("never-verified");
    expect(summary.health.neverVerifiedCount).toBe(1);
    // No refresh failed here; saying one did is the mt#4605 defect.
    expect(summary.health.sourceUnavailableCount).toBe(0);
  });

  test("a snapshot carrying BOTH reports both counts, so neither stands in for the other", () => {
    // The mix is representable without `sourceFailures` claiming the whole
    // source died: one row's canary section is null (that row alone is
    // unreadable), another has genuinely never been verified. A single `kind`
    // cannot say this, which is why the counts are what a renderer reads.
    const summary = deriveProtectionSummary(
      snapshot([
        row({ guardName: "unreadable", canary: null }),
        row({ guardName: "untested-a", canary: { state: "never-verified" } }),
        row({ guardName: "untested-b", canary: { state: "never-verified" } }),
      ]),
      [
        { guardName: "unreadable", failureClasses: ["lost-signal"] },
        { guardName: "untested-a", failureClasses: ["lost-signal"] },
        { guardName: "untested-b", failureClasses: ["lost-signal"] },
      ],
      QUESTIONS
    );
    expect(summary.health.sourceUnavailableCount).toBe(1);
    expect(summary.health.neverVerifiedCount).toBe(2);
    // Precedence names the transient one — it is today's news — while the
    // permanent count stays visible beside it rather than being erased.
    expect(summary.health.kind).toBe(SOURCE_UNAVAILABLE);
    expect(summary.health.totalChecks).toBe(3);
  });

  test("one broken check makes its class degraded and outranks both indeterminate states", () => {
    const summary = deriveProtectionSummary(
      snapshot([
        row({ guardName: "broken-one", canary: { state: "broken" } }),
        row({ guardName: "fine-one", canary: { state: "never-verified" } }),
      ]),
      [
        { guardName: "broken-one", failureClasses: ["secret-exposure"] },
        { guardName: "fine-one", failureClasses: ["lost-signal"] },
      ],
      QUESTIONS
    );
    expect(summary.health.kind).toBe("degraded");
    expect(summary.health.degradedCount).toBe(1);
    const secret = summary.classes.filter((c) => c.classId === "secret-exposure");
    expect(secret).toHaveLength(1);
    expect(onlyClass(secret).health).toBe("degraded");
    expect(onlyClass(secret).degradedCount).toBe(1);
  });

  test("all checks confirmed working folds to working", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "a" }), row({ guardName: "b", deny: 1 })]),
      [
        { guardName: "a", failureClasses: ["lost-signal"] },
        { guardName: "b", failureClasses: ["lost-signal"] },
      ],
      QUESTIONS
    );
    expect(summary.health.kind).toBe("working");
    expect(summary.health.totalChecks).toBe(2);
  });
});

describe("deriveProtectionSummary — ordering", () => {
  test("degraded first, then cost descending — not alphabetical and not by check count", () => {
    // `lost-signal` has the most CHECKS and the least cost; `secret-exposure`
    // has one check and is degraded. An alphabetical sort would lead with
    // `lost-signal`; a count sort would too. Both are wrong for this surface.
    const summary = deriveProtectionSummary(
      snapshot([
        row({ guardName: "quiet-a" }),
        row({ guardName: "quiet-b" }),
        row({ guardName: "quiet-c" }),
        row({ guardName: "costly", deny: 40, warn: 60 }),
        row({ guardName: "secret-guard", canary: { state: "broken" } }),
      ]),
      [
        { guardName: "quiet-a", failureClasses: ["lost-signal"] },
        { guardName: "quiet-b", failureClasses: ["lost-signal"] },
        { guardName: "quiet-c", failureClasses: ["lost-signal"] },
        { guardName: "costly", failureClasses: [UNREVIEWED_MERGE] },
        { guardName: "secret-guard", failureClasses: ["secret-exposure"] },
      ],
      QUESTIONS
    );

    expect(summary.classes.map((c) => c.classId)).toEqual([
      "secret-exposure", // degraded — wins regardless of its zero cost
      UNREVIEWED_MERGE, // 100 interruptions
      "lost-signal", // 3 checks, 0 interruptions — last despite being biggest
    ]);
  });
});

describe("deriveProtectionSummary — coverage", () => {
  test("a declared-only interceptor that never fired still counts as a check", () => {
    const summary = deriveProtectionSummary(
      snapshot([], { declaredOnlyRows: [row({ guardName: "never-fired" })] }),
      [{ guardName: "never-fired", failureClasses: ["secret-exposure"] }],
      QUESTIONS
    );
    expect(summary.totals.checkCount).toBe(1);
    expect(onlyClass(summary.classes).checkCount).toBe(1);
    expect(onlyClass(summary.classes).ledger.interruptions).toBe(0);
    expect(summary.health.kind).toBe("working");
  });

  test("a class with no authored question renders with its key rather than vanishing", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g" })]),
      [{ guardName: "g", failureClasses: ["not-in-the-copy-layer"] }],
      QUESTIONS
    );
    expect(summary.classes).toHaveLength(1);
    expect(onlyClass(summary.classes).question).toBe("not-in-the-copy-layer");
  });

  test("an entry with no aggregate row contributes a check but no figures", () => {
    const summary = deriveProtectionSummary(
      snapshot([]),
      [{ guardName: "absent", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(onlyClass(summary.classes).checkCount).toBe(1);
    expect(onlyClass(summary.classes).ledger.timeMs).toBeNull();
    expect(summary.totals.checkCount).toBe(1);
  });
});
