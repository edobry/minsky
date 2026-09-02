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
  evidenceFor,
  ordersDiffer,
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
