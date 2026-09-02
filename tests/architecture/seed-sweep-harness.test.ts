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
 * (mem#704).
 */
import { describe, expect, test } from "bun:test";
import {
  orderDependentFailures,
  ordersDiffer,
  parseFailureNames,
  parseSeedArg,
  repoRandomizeEnabled,
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

describe("orderDependentFailures", () => {
  const BASELINE = ["mt#3377 provisioning A", "mt#3377 provisioning B"];

  test("subtracts the standing red set, leaving only what ordering caused", () => {
    const seed = [...BASELINE, "guardHealth not in registry"];

    expect(orderDependentFailures(BASELINE, seed)).toEqual(["guardHealth not in registry"]);
  });

  test("a seed that reproduces only baseline failures is clean", () => {
    expect(orderDependentFailures(BASELINE, BASELINE)).toEqual([]);
  });

  test("an empty baseline attributes every failure to ordering", () => {
    expect(orderDependentFailures([], ["x"])).toEqual(["x"]);
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
