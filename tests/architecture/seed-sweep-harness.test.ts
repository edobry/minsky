/**
 * Tests for the seed-sweep harness's decision logic (mt#3575).
 *
 * The pure functions are tested here against synthetic input rather than by
 * running the suite twenty times (mem#316 — functional core, imperative shell).
 * The real sweep runs as its own command (`bun run test:seed-sweep`).
 *
 * The cases that matter most are the REFUSAL ones: this harness exists because
 * the obvious seed loop is a probe that cannot fail, so a harness that reports
 * "clean" when nothing shuffled would reproduce the exact defect it replaces
 * (mem#704). The `classifySweep` cases carry a second refusal of the same
 * shape — a finding no fixed-seed repeat covered is reported UNCLASSIFIED
 * rather than promoted to a verdict the evidence does not support.
 */
import { describe, expect, test } from "bun:test";
import {
  classifySweep,
  detectCountDrift,
  evidenceFor,
  ordersDiffer,
  parseExecutedTestCount,
  parseFailureNames,
  parseSeedArg,
  repoRandomizeEnabled,
  type SeedObservation,
} from "../../scripts/run-tests-seed-sweep";

describe("repoRandomizeEnabled", () => {
  test("true only when [test] randomize is literally true", () => {
    expect(repoRandomizeEnabled("[test]\nrandomize = true\n")).toBe(true);
    expect(repoRandomizeEnabled("[test]\nrandomize = false\n")).toBe(false);
  });

  test("an absent key is not enabled — bun's default is declaration order", () => {
    expect(repoRandomizeEnabled('[test]\npreload = ["./tests/setup.ts"]\n')).toBe(false);
    expect(repoRandomizeEnabled("")).toBe(false);
  });

  test("comments mentioning the key do not enable it", () => {
    // bunfig.toml's own comment block discusses `randomize = false` at length.
    // Matching that prose would make the harness vouch for a sweep that shuffles
    // nothing — the same prose-is-not-configuration mistake the sweep guards.
    const commented =
      "[test]\n# this was `randomize = true` once, and was a no-op\nrandomize = false\n";

    expect(repoRandomizeEnabled(commented)).toBe(false);
  });

  test("a randomize key in a DIFFERENT section does not count", () => {
    expect(repoRandomizeEnabled("[install]\nrandomize = true\n")).toBe(false);
  });
});

describe("ordersDiffer", () => {
  test("identical orders are not different — the refusal case", () => {
    expect(ordersDiffer(["a", "b", "c"], ["a", "b", "c"])).toBe(false);
  });

  test("a permutation is different", () => {
    expect(ordersDiffer(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  test("an empty observation is never treated as proof of shuffling", () => {
    // A probe that produced no output tells us nothing; reading that as
    // "different" would let a broken probe green-light the whole sweep.
    expect(ordersDiffer([], [])).toBe(false);
    expect(ordersDiffer([], ["a"])).toBe(false);
  });

  test("differing lengths count as different", () => {
    expect(ordersDiffer(["a"], ["a", "b"])).toBe(true);
  });
});

describe("parseFailureNames", () => {
  test("extracts (fail) lines and strips the duration suffix", () => {
    const output = [
      "bun test v1.3.14",
      "(pass) something fine [1.00ms]",
      "(fail) debug.systemInfo guardHealth surface (mt#2812) > guardHealth co-exists [0.05ms]",
      "(fail) another one",
      " 5 fail",
    ].join("\n");

    expect(parseFailureNames(output)).toEqual([
      "debug.systemInfo guardHealth surface (mt#2812) > guardHealth co-exists",
      "another one",
    ]);
  });

  test("a clean run yields no names", () => {
    expect(parseFailureNames("bun test v1.3.14\n 16 pass\n 0 fail\n")).toEqual([]);
  });
});

describe("parseExecutedTestCount", () => {
  test("reads bun's run summary, singular and plural", () => {
    expect(parseExecutedTestCount("Ran 17132 tests across 1117 files. [370.00s]")).toBe(17132);
    expect(parseExecutedTestCount("Ran 1 test across 1 file. [12.00ms]")).toBe(1);
  });

  test("tolerates the leading whitespace bun emits", () => {
    expect(parseExecutedTestCount("  Ran 24 tests across 1 file. [121.00ms]")).toBe(24);
  });

  test("output with NO summary line is null, not zero", () => {
    // The whole point. A run that died prints failures-so-far and no summary;
    // returning 0 would make a dead run indistinguishable from a run that
    // legitimately executed nothing, and both would read as a clean sweep.
    expect(parseExecutedTestCount("bun test v1.3.14\n(fail) something\n")).toBeNull();
    expect(parseExecutedTestCount("")).toBeNull();
  });

  test("a truncated summary line does not half-match", () => {
    expect(parseExecutedTestCount("Ran 17132 tests across")).toBeNull();
  });

  // The sweep runs three suites per seed and concatenates their output, so the
  // guard's question changed from "is there a summary?" to "is there one from
  // EVERY suite?" (mt#3575). Matching only the first would let suites 2..N die
  // behind suite 1's healthy line — the same can't-fail shape, one level up.
  const THREE_SUITES = [
    "=== suite: main ===",
    "Ran 17356 tests across 1125 files. [303.00s]",
    "=== suite: hooks ===",
    "Ran 900 tests across 60 files. [30.00s]",
    "=== suite: components ===",
    "Ran 2837 tests across 213 files. [32.00s]",
  ].join("\n");

  test("sums every suite's summary when all expected suites reported", () => {
    expect(parseExecutedTestCount(THREE_SUITES, 3)).toBe(17356 + 900 + 2837);
  });

  test("a MISSING suite summary is null even though the others are present", () => {
    const twoOfThree = THREE_SUITES.split("\n").slice(0, 4).join("\n");
    expect(parseExecutedTestCount(twoOfThree, 3)).toBeNull();
    // ...and the same text is fine when only two suites were expected, so the
    // refusal tracks the expectation rather than a hardcoded count.
    expect(parseExecutedTestCount(twoOfThree, 2)).toBe(17356 + 900);
  });

  test("defaults to expecting one summary, so single-suite callers are unchanged", () => {
    expect(parseExecutedTestCount("Ran 24 tests across 1 file. [121.00ms]")).toBe(24);
  });
});

describe("detectCountDrift", () => {
  test("identical counts across seeds are not drift", () => {
    const result = detectCountDrift([
      { seed: 1, failures: [], executedTests: 17132 },
      { seed: 2, failures: [], executedTests: 17132 },
    ]);

    expect(result.drifted).toBe(false);
    expect(result.counts).toEqual([17132]);
  });

  test("a differing count is drift, and both values are reported", () => {
    // Only the ORDER changes between seeds, so a moved count means a file did
    // not load under one of them — order-dependence that reports no failing
    // test, because a file that never loads has none to report.
    const result = detectCountDrift([
      { seed: 1, failures: [], executedTests: 17132 },
      { seed: 2, failures: [], executedTests: 17098 },
    ]);

    expect(result.drifted).toBe(true);
    expect(result.counts).toEqual([17098, 17132]);
  });

  test("observations carrying no count are ignored rather than read as zero", () => {
    const result = detectCountDrift([
      { seed: 1, failures: [], executedTests: 17132 },
      { seed: 2, failures: [] },
    ]);

    expect(result.drifted).toBe(false);
    expect(result.counts).toEqual([17132]);
  });

  test("no observations is not drift", () => {
    expect(detectCountDrift([])).toEqual({ drifted: false, counts: [] });
  });
});

describe("classifySweep — the cross-seed axis", () => {
  const STANDING = "mt#3377 provisioning";
  const ORDERED = "guardHealth not in registry";

  test("varied across seeds AND reproduced under its own seed is order-dependent", () => {
    const result = classifySweep([
      { seed: 1, failures: [STANDING, ORDERED], repeatFailures: [STANDING, ORDERED] },
      { seed: 2, failures: [STANDING], repeatFailures: [STANDING] },
      { seed: 3, failures: [STANDING, ORDERED], repeatFailures: [STANDING, ORDERED] },
    ]);

    expect(result.orderDependent).toEqual([ORDERED]);
    expect(result.standingRed).toEqual([STANDING]);
    expect(result.loadSensitive).toEqual([]);
    expect(result.unclassified).toEqual([]);
  });

  test("a failure present under EVERY order is standing red, not this sweep's finding", () => {
    const result = classifySweep([
      { seed: 1, failures: [STANDING], repeatFailures: [STANDING] },
      { seed: 2, failures: [STANDING], repeatFailures: [STANDING] },
    ]);

    expect(result.standingRed).toEqual([STANDING]);
    expect(result.orderDependent).toEqual([]);
  });

  test("standing red is judged on FIRST runs only, so repeats cannot skew that axis", () => {
    // Failed in every first run — one sample per order, which is the axis's unit.
    // A repeat that happened to pass does not turn it into a cross-seed finding.
    const result = classifySweep([
      { seed: 1, failures: [STANDING], repeatFailures: [STANDING] },
      { seed: 2, failures: [STANDING], repeatFailures: [] },
    ]);

    expect(result.standingRed).toEqual([STANDING]);
    expect(result.loadSensitive).toEqual([]);
  });

  test("all-clean seeds yield nothing in any bucket", () => {
    expect(
      classifySweep([
        { seed: 1, failures: [] },
        { seed: 2, failures: [] },
      ])
    ).toEqual({
      orderDependent: [],
      loadSensitive: [],
      standingRed: [],
      unclassified: [],
    });
  });

  test("a name repeated within one run still counts as one observation", () => {
    // Otherwise a test failing twice in one run could be misread as failing in
    // two orders, and a genuinely order-dependent failure would be misfiled as
    // standing red — the direction that HIDES a finding.
    const result = classifySweep([
      { seed: 1, failures: [ORDERED, ORDERED], repeatFailures: [ORDERED] },
      { seed: 2, failures: [], repeatFailures: undefined },
    ]);

    expect(result.orderDependent).toEqual([ORDERED]);
    expect(result.standingRed).toEqual([]);
  });

  test("no observations yields nothing rather than throwing", () => {
    expect(classifySweep([])).toEqual({
      orderDependent: [],
      loadSensitive: [],
      standingRed: [],
      unclassified: [],
    });
  });
});

describe("classifySweep — the fixed-seed discriminator", () => {
  const LOAD = "startTranscriptSweepBackstop (mt#2321) > overlapping ticks are skipped";
  const ORDERED = "guardHealth not in registry";

  test("a failure that flips under a FIXED seed is contention, not order-dependence", () => {
    // The same seed is the same order. If the outcome changed anyway, something
    // other than the order moved (mem#942). This is the case that made the
    // 2026-09-02 sweep re-report mt#3501's population as this task's findings.
    const result = classifySweep([
      { seed: 1, failures: [LOAD], repeatFailures: [] },
      { seed: 2, failures: [], repeatFailures: undefined },
    ]);

    expect(result.loadSensitive).toEqual([LOAD]);
    expect(result.orderDependent).toEqual([]);
  });

  test("a failure appearing ONLY in the repeat run is also a flip", () => {
    const result = classifySweep([
      { seed: 1, failures: [ORDERED], repeatFailures: [ORDERED, LOAD] },
      { seed: 2, failures: [], repeatFailures: undefined },
    ]);

    expect(result.loadSensitive).toEqual([LOAD]);
    expect(result.orderDependent).toEqual([ORDERED]);
  });

  test("one flip outranks a repeat at another seed", () => {
    // Seeing a failure twice is equally consistent with contention that landed
    // twice; seeing it flip while the order is HELD CONSTANT is positive
    // evidence that something other than the order moved. The flip wins.
    const result = classifySweep([
      { seed: 1, failures: [LOAD], repeatFailures: [LOAD] },
      { seed: 2, failures: [LOAD], repeatFailures: [] },
      { seed: 3, failures: [], repeatFailures: undefined },
    ]);

    expect(result.loadSensitive).toEqual([LOAD]);
    expect(result.orderDependent).toEqual([]);
  });

  test("a finding no repeat covered is UNCLASSIFIED, never promoted", () => {
    // The refusal case. Without a fixed-seed observation there is no evidence
    // on the discriminating axis, and reporting it as order-dependent would be
    // the pre-discriminator harness's exact over-report.
    const result = classifySweep([
      { seed: 1, failures: [ORDERED] },
      { seed: 2, failures: [] },
    ]);

    expect(result.unclassified).toEqual([ORDERED]);
    expect(result.orderDependent).toEqual([]);
    expect(result.loadSensitive).toEqual([]);
  });
});

describe("evidenceFor", () => {
  const NAME = "some test";

  test("renders first-run and repeat outcomes per seed", () => {
    const observations: SeedObservation[] = [
      { seed: 1, failures: [NAME], repeatFailures: [NAME] },
      { seed: 2, failures: [NAME], repeatFailures: [] },
      { seed: 3, failures: [], repeatFailures: undefined },
    ];

    expect(evidenceFor(NAME, observations)).toBe("s1:FF s2:F. s3:.—");
  });

  test("an untaken repeat is marked, not rendered as a pass", () => {
    // "." would claim the test was observed passing on a run that never happened.
    expect(evidenceFor(NAME, [{ seed: 7, failures: [NAME] }])).toBe("s7:F—");
  });
});

describe("parseSeedArg", () => {
  test("defaults when absent, and reads an explicit count", () => {
    expect(parseSeedArg(["bun", "script"])).toBe(20);
    expect(parseSeedArg(["bun", "script", "--seeds", "5"])).toBe(5);
  });

  test("a missing or nonsense value falls back rather than running zero seeds", () => {
    // Running zero seeds would exit 0 having proved nothing.
    expect(parseSeedArg(["bun", "script", "--seeds"])).toBe(20);
    expect(parseSeedArg(["bun", "script", "--seeds", "0"])).toBe(20);
    expect(parseSeedArg(["bun", "script", "--seeds", "abc"])).toBe(20);
  });
});
