/**
 * Tests for services/reviewer/src/findings-aggregation.ts (mt#3295 SC#3).
 */

import { describe, test, expect, mock } from "bun:test";
import {
  classifyFindingCategory,
  aggregateRecurringCategories,
  loadFindingsAggregationConfig,
  runFindingsAggregationCycle,
  startFindingsAggregationScheduler,
  type FindingsAggregationConfig,
} from "./findings-aggregation";
import type { ReviewerDb } from "./db/client";

// ---------------------------------------------------------------------------
// Shared literal constants — avoids custom/no-magic-string-duplication warnings.
// ---------------------------------------------------------------------------

const CATEGORY_UNGUARDED_EDGE_CASE = "unguarded-edge-case";
const ENV_FINDINGS_AGGREGATION_ENABLED = "FINDINGS_AGGREGATION_ENABLED";
const ENV_FINDINGS_AGGREGATION_WINDOW_DAYS = "FINDINGS_AGGREGATION_WINDOW_DAYS";

// ---------------------------------------------------------------------------
// classifyFindingCategory
// ---------------------------------------------------------------------------

describe("classifyFindingCategory", () => {
  test("classifies doc-code-divergence", () => {
    expect(
      classifyFindingCategory(
        "Docstring is stale",
        "The jsdoc comment contradicts the logic below."
      )
    ).toBe("doc-code-divergence");
  });

  test("classifies spec-evidence-unmet", () => {
    expect(
      classifyFindingCategory(
        "Acceptance criterion not met",
        "Success criteria 3 is not met by this PR."
      )
    ).toBe("spec-evidence-unmet");
  });

  test("classifies silent-failure", () => {
    expect(
      classifyFindingCategory("Swallowed error", "This catch block silently swallows the error.")
    ).toBe("silent-failure");
  });

  test("classifies test-quality", () => {
    expect(
      classifyFindingCategory(
        "Placeholder test",
        "This test uses a placeholder assertion expect(true).toBe(true)."
      )
    ).toBe("test-quality");
  });

  test("classifies sibling-path-missed", () => {
    expect(
      classifyFindingCategory(
        "Sibling path missed",
        "The run() path was fixed but the sibling call site was not."
      )
    ).toBe("sibling-path-missed");
  });

  test("classifies wiring-gap", () => {
    expect(
      classifyFindingCategory(
        "Not wired",
        "The new export is never registered and has no consumers found."
      )
    ).toBe("wiring-gap");
  });

  test("classifies stale-reference", () => {
    expect(classifyFindingCategory("Stale reference", "This references a removed function.")).toBe(
      "stale-reference"
    );
  });

  test("classifies regression", () => {
    expect(
      classifyFindingCategory(
        "Regression",
        "This used to work before this change and now it is broken."
      )
    ).toBe("regression");
  });

  test("classifies info-disclosure", () => {
    expect(
      classifyFindingCategory("Secret leak", "This change exposes a credential in the log output.")
    ).toBe("info-disclosure");
  });

  test("classifies scope-expansion", () => {
    expect(
      classifyFindingCategory("Scope creep", "This change is out of scope for the stated task.")
    ).toBe("scope-expansion");
  });

  test("classifies logic-bug", () => {
    expect(
      classifyFindingCategory("Logic error", "This is an off-by-one logic bug in the loop bound.")
    ).toBe("logic-bug");
  });

  test("classifies unguarded-edge-case", () => {
    expect(
      classifyFindingCategory(
        "Missing guard",
        "This call site is missing a null check before dereferencing."
      )
    ).toBe("unguarded-edge-case");
  });

  test("falls back to other when nothing matches", () => {
    expect(classifyFindingCategory("Just a comment", "Consider renaming this variable.")).toBe(
      "other"
    );
  });

  test("more specific categories win over broader ones (silent-failure over unguarded-edge-case)", () => {
    // "missing" and "check" are generic-sounding, but the silent-failure
    // pattern is checked first and should win when both vocabularies appear.
    const category = classifyFindingCategory(
      "Swallowed error",
      "This catch block silently swallows the error instead of surfacing it."
    );
    expect(category).toBe("silent-failure");
  });
});

// ---------------------------------------------------------------------------
// aggregateRecurringCategories — DB interaction
// ---------------------------------------------------------------------------

function makeSelectDb(rows: Array<{ title: string; body: string }>): ReviewerDb {
  return {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve(rows)),
      })),
    })),
  } as unknown as ReviewerDb;
}

describe("aggregateRecurringCategories", () => {
  test("groups and sorts by count descending", async () => {
    const db = makeSelectDb([
      { title: "Missing guard", body: "unguarded edge case" },
      { title: "Missing guard 2", body: "another unguarded edge case, missing check" },
      { title: "Swallowed", body: "silently swallows the error" },
    ]);

    const result = await aggregateRecurringCategories(db, { windowDays: 5 });
    expect(result[0]).toEqual({ category: CATEGORY_UNGUARDED_EDGE_CASE, count: 2 });
    expect(result[1]).toEqual({ category: "silent-failure", count: 1 });
  });

  test("returns an empty array when there are no rows", async () => {
    const db = makeSelectDb([]);
    const result = await aggregateRecurringCategories(db, { windowDays: 5 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadFindingsAggregationConfig
// ---------------------------------------------------------------------------

describe("loadFindingsAggregationConfig", () => {
  test("defaults to disabled with a 5-day window", () => {
    const originalEnabled = process.env[ENV_FINDINGS_AGGREGATION_ENABLED];
    const originalWindow = process.env[ENV_FINDINGS_AGGREGATION_WINDOW_DAYS];
    delete process.env[ENV_FINDINGS_AGGREGATION_ENABLED];
    delete process.env[ENV_FINDINGS_AGGREGATION_WINDOW_DAYS];

    try {
      const config = loadFindingsAggregationConfig();
      expect(config.enabled).toBe(false);
      expect(config.windowDays).toBe(5);
      expect(config.topN).toBe(5);
    } finally {
      if (originalEnabled !== undefined)
        process.env[ENV_FINDINGS_AGGREGATION_ENABLED] = originalEnabled;
      if (originalWindow !== undefined)
        process.env[ENV_FINDINGS_AGGREGATION_WINDOW_DAYS] = originalWindow;
    }
  });
});

// ---------------------------------------------------------------------------
// runFindingsAggregationCycle
// ---------------------------------------------------------------------------

const BASE_CONFIG: FindingsAggregationConfig = {
  enabled: true,
  intervalMs: 1000,
  windowDays: 5,
  topN: 2,
};

describe("runFindingsAggregationCycle", () => {
  test("returns totalFindings and topCategories, capped at topN", async () => {
    const db = makeSelectDb([
      { title: "a", body: "unguarded edge case" },
      { title: "b", body: "unguarded edge case, missing check" },
      { title: "c", body: "silently swallows the error" },
      { title: "d", body: "logic error off-by-one" },
    ]);

    const result = await runFindingsAggregationCycle(db, BASE_CONFIG);
    expect(result.totalFindings).toBe(4);
    expect(result.topCategories).toHaveLength(2);
    expect(result.topCategories[0]?.category).toBe(CATEGORY_UNGUARDED_EDGE_CASE);
  });

  test("does not throw on a DB error; returns an empty result", async () => {
    const throwingDb = {
      select: mock(() => {
        throw new Error("connection refused");
      }),
    } as unknown as ReviewerDb;

    const result = await runFindingsAggregationCycle(throwingDb, BASE_CONFIG);
    expect(result).toEqual({ totalFindings: 0, topCategories: [] });
  });
});

// ---------------------------------------------------------------------------
// startFindingsAggregationScheduler
// ---------------------------------------------------------------------------

describe("startFindingsAggregationScheduler", () => {
  test("returns null when disabled", () => {
    const db = makeSelectDb([]);
    const handle = startFindingsAggregationScheduler(db, { ...BASE_CONFIG, enabled: false });
    expect(handle).toBeNull();
  });

  test("returns a timer handle when enabled", () => {
    const db = makeSelectDb([]);
    const handle = startFindingsAggregationScheduler(db, BASE_CONFIG);
    expect(handle).not.toBeNull();
    if (handle) clearInterval(handle);
  });

  test("returns null when db is undefined (degraded boot)", () => {
    const handle = startFindingsAggregationScheduler(undefined, BASE_CONFIG);
    expect(handle).toBeNull();
  });
});
