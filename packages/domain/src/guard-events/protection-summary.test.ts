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

describe("deriveProtectionSummary — unknown is never zero, and never working", () => {
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

  test("a failed canary source renders unknown, not working", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g", canary: { state: "passing" } })], {
        sourceFailures: ["canary"],
      }),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.health.kind).toBe("unknown");
    expect(onlyClass(summary.classes).health).toBe("unknown");
    expect(summary.health.degradedCount).toBe(0);
  });

  test("a never-verified check is unknown, not working — it has not been shown to work", () => {
    const summary = deriveProtectionSummary(
      snapshot([row({ guardName: "g", canary: { state: "never-verified" } })]),
      [{ guardName: "g", failureClasses: ["lost-signal"] }],
      QUESTIONS
    );
    expect(summary.health.kind).toBe("unknown");
  });

  test("one broken check makes its class degraded and outranks unknown at the corpus level", () => {
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
