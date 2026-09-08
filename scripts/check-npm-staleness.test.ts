import { describe, expect, test } from "bun:test";
import { assessStaleness, MAX_DAYS_BEHIND, type StalenessInputs } from "./check-npm-staleness";

/**
 * A fixed clock. Every date-relative fixture below is derived from THIS value
 * rather than from the real clock, so the suite cannot pass today and fail on a
 * date nobody chose (`testing-standards.mdc §Testable Design → the clock is
 * injected`, and the fixtures anchor to the same value the test injects).
 */
const NOW = Date.parse("2026-09-07T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(NOW - n * MS_PER_DAY).toISOString();

function inputs(overrides: Partial<StalenessInputs> = {}): StalenessInputs {
  return {
    publishedVersion: "0.1.2",
    publishedAt: daysAgo(1),
    mainVersion: "0.2.0-dev.0",
    commitsSincePublish: 3,
    ...overrides,
  };
}

describe("both directions, or the check is unfalsifiable (AT1)", () => {
  // The whole point of the pair: a staleness check that can only ever say
  // "stale" is not a check, and neither is one that can only say "fine".
  test("reports STALE when main is far ahead", () => {
    const verdict = assessStaleness(inputs({ publishedAt: daysAgo(27) }), NOW);
    expect(verdict.stale).toBe(true);
    expect(verdict.daysBehind).toBe(27);
    expect(verdict.report[0]).toContain("STALE");
  });

  test("reports OK when a release is current", () => {
    const verdict = assessStaleness(inputs({ publishedAt: daysAgo(1) }), NOW);
    expect(verdict.stale).toBe(false);
    expect(verdict.daysBehind).toBe(1);
    expect(verdict.report[0]).toContain("OK");
  });
});

describe("the threshold boundary", () => {
  test(`${MAX_DAYS_BEHIND} days is still OK`, () => {
    const verdict = assessStaleness(inputs({ publishedAt: daysAgo(MAX_DAYS_BEHIND) }), NOW);
    expect(verdict.daysBehind).toBe(MAX_DAYS_BEHIND);
    expect(verdict.stale).toBe(false);
  });

  test(`${MAX_DAYS_BEHIND + 1} days is stale`, () => {
    const verdict = assessStaleness(inputs({ publishedAt: daysAgo(MAX_DAYS_BEHIND + 1) }), NOW);
    expect(verdict.daysBehind).toBe(MAX_DAYS_BEHIND + 1);
    expect(verdict.stale).toBe(true);
  });

  test("a same-day publish is 0 days behind, never negative", () => {
    const verdict = assessStaleness(inputs({ publishedAt: daysAgo(0) }), NOW);
    expect(verdict.daysBehind).toBe(0);
    expect(verdict.stale).toBe(false);
  });
});

describe("version indistinguishability is reported independently of staleness", () => {
  // This is the half that made the incident invisible: the gap was 27 days AND
  // both sides read 0.1.2, so "upgrade to the latest" was already satisfied.
  test("flags matching versions even on an otherwise-fresh release", () => {
    const verdict = assessStaleness(
      inputs({ publishedAt: daysAgo(1), publishedVersion: "0.2.0", mainVersion: "0.2.0" }),
      NOW
    );
    expect(verdict.stale).toBe(false);
    expect(verdict.versionsIndistinguishable).toBe(true);
    expect(verdict.report.join("\n")).toContain("nothing distinguishes");
  });

  test("does not flag when main carries a dev suffix", () => {
    const verdict = assessStaleness(
      inputs({ publishedVersion: "0.2.0", mainVersion: "0.2.1-dev.0" }),
      NOW
    );
    expect(verdict.versionsIndistinguishable).toBe(false);
    expect(verdict.report.join("\n")).not.toContain("nothing distinguishes");
  });

  test("reproduces the originating incident exactly", () => {
    // 2026-09-05: npm 0.1.2, main 0.1.2, published 2026-08-11. Both failure
    // modes at once, which is why nobody caught it.
    const verdict = assessStaleness(
      {
        publishedVersion: "0.1.2",
        publishedAt: "2026-08-11T18:59:54.000Z",
        mainVersion: "0.1.2",
        commitsSincePublish: 1244,
      },
      Date.parse("2026-09-07T00:00:00.000Z")
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.daysBehind).toBe(26);
    expect(verdict.versionsIndistinguishable).toBe(true);
  });
});

describe("the commit count informs and never gates", () => {
  test("a huge commit count on a fresh release is still OK", () => {
    const verdict = assessStaleness(
      inputs({ publishedAt: daysAgo(1), commitsSincePublish: 5000 }),
      NOW
    );
    expect(verdict.stale).toBe(false);
    expect(verdict.commitsSincePublish).toBe(5000);
  });

  test("-1 marks a missing tag rather than reading as in-sync", () => {
    // 0 would say "no commits since the tag", which is a different fact from
    // "there is no tag" and would read as perfectly current.
    const verdict = assessStaleness(inputs({ commitsSincePublish: -1 }), NOW);
    expect(verdict.commitsSincePublish).toBe(-1);
    expect(verdict.report.join("\n")).toContain("-1");
  });
});

describe("an unusable timestamp fails loudly", () => {
  test("throws rather than silently reporting not-stale", () => {
    // Date.parse returns NaN, and every comparison against NaN is false — so a
    // subtraction would quietly bucket this into the only arm that cannot fail
    // (mem#954, one layer down).
    expect(() => assessStaleness(inputs({ publishedAt: "not-a-date" }), NOW)).toThrow(
      /unparseable publishedAt/
    );
  });
});
