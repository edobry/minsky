/**
 * mt#3600 — `getTranscriptCoverage` reaches both branches from an EXPLICIT
 * provider, not from whatever the developer's machine has configured.
 *
 * These cases are the reason `sweeps.test.ts` no longer asserts a null coverage
 * block: that assertion encoded "this harness has no SQL provider", which is
 * false on a configured machine and true only until some sibling test in the
 * same bun process initializes the shared persistence singleton. The route test
 * now asserts the field's PRESENCE (mt#3441's actual point) and the value
 * semantics are pinned here, where the provider is supplied rather than assumed.
 */

import { describe, expect, test } from "bun:test";
import { getTranscriptCoverage, type TranscriptCoverageDeps } from "./transcript-coverage";

/** A provider with no `getDatabaseConnection` — the not-SQL-capable branch. */
function providerWithoutSql(): TranscriptCoverageDeps {
  return { getProvider: async () => ({ kind: "in-memory" }) };
}

/** A SQL-capable provider whose aggregate query returns `row`. */
function providerWithRow(row: {
  total: number;
  withTitle: number;
  withSummary: number;
}): TranscriptCoverageDeps {
  return {
    getProvider: async () => ({
      // `capabilities` as of mt#4543 — the branch under test asks the capability now,
      // not merely whether the method exists. The subject here is the aggregate maths;
      // the provider shape is scaffolding.
      capabilities: { sql: true },
      getDatabaseConnection: async () => ({
        select: () => ({ from: async () => [row] }),
      }),
    }),
  };
}

describe("getTranscriptCoverage", () => {
  test("returns null when the provider is not SQL-capable", async () => {
    expect(await getTranscriptCoverage(providerWithoutSql())).toBeNull();
  });

  test("returns null when the provider is SQL-capable but has no connection", async () => {
    const deps: TranscriptCoverageDeps = {
      getProvider: async () => ({ getDatabaseConnection: async () => null }),
    };
    expect(await getTranscriptCoverage(deps)).toBeNull();
  });

  test("returns null — not a throw — when the provider fails", async () => {
    const deps: TranscriptCoverageDeps = {
      getProvider: async () => {
        throw new Error("persistence unavailable");
      },
    };
    expect(await getTranscriptCoverage(deps)).toBeNull();
  });

  test("measures coverage and derives percentages to 2dp", async () => {
    const coverage = await getTranscriptCoverage(
      providerWithRow({ total: 2540, withTitle: 1151, withSummary: 2536 })
    );

    expect(coverage).toEqual({
      total: 2540,
      withTitle: 1151,
      withSummary: 2536,
      titlePct: 45.31,
      summaryPct: 99.84,
    });
  });

  test("a measured ZERO is distinct from not-measured", async () => {
    // The distinction mt#3441 exists to preserve: a sweeper producing nothing
    // reports 0%, and an unmeasurable one reports null. Collapsing them is what
    // let SummaryPipeline sit at 0.5% unnoticed.
    const coverage = await getTranscriptCoverage(
      providerWithRow({ total: 100, withTitle: 0, withSummary: 0 })
    );

    expect(coverage).not.toBeNull();
    expect(coverage?.titlePct).toBe(0);
    expect(coverage?.summaryPct).toBe(0);
  });

  test("an empty table divides by zero safely", async () => {
    const coverage = await getTranscriptCoverage(
      providerWithRow({ total: 0, withTitle: 0, withSummary: 0 })
    );

    expect(coverage?.total).toBe(0);
    expect(coverage?.titlePct).toBe(0);
  });

  test("returns null when the aggregate yields no row", async () => {
    const deps: TranscriptCoverageDeps = {
      getProvider: async () => ({
        getDatabaseConnection: async () => ({
          select: () => ({ from: async () => [] }),
        }),
      }),
    };
    expect(await getTranscriptCoverage(deps)).toBeNull();
  });
});
