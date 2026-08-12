/**
 * Tests for the mt#4007 canary-report -> persistable-rows mapping
 * (`scripts/lib/guard-canary-persistence-mapping.ts`).
 *
 * Split from `scripts/run-guard-canaries.ts` (which has top-level side
 * effects unsafe to import from a test process — see that module's doc
 * comment) specifically so these pure functions are directly testable
 * against their real implementation.
 */

import { describe, test, expect } from "bun:test";
import type { CanaryResult, CanaryReport } from "../../.minsky/hooks/canary-runner";
import { buildFailureDetail, buildPersistableOutcomes } from "./guard-canary-persistence-mapping";

function makeResult(overrides: Partial<CanaryResult>): CanaryResult {
  return {
    guardName: "some-guard",
    source: "registry",
    expects: "deny",
    passed: true,
    ...overrides,
  };
}

describe("buildFailureDetail", () => {
  test("null on a pass", () => {
    expect(buildFailureDetail(makeResult({ passed: true }))).toBeNull();
  });

  test("the thrown error message, when present", () => {
    expect(buildFailureDetail(makeResult({ passed: false, error: "run() threw: boom" }))).toBe(
      "run() threw: boom"
    );
  });

  test("a synthesized mismatch summary when failed without a thrown error", () => {
    expect(
      buildFailureDetail(makeResult({ passed: false, expects: "warn", error: undefined }))
    ).toBe("canary ran but its outcome did not satisfy expects=warn");
  });

  test("names the outcome as undeclared when expects itself is missing (defensive)", () => {
    expect(
      buildFailureDetail(makeResult({ passed: false, expects: undefined, error: undefined }))
    ).toBe("canary ran but its outcome did not satisfy expects=(undeclared)");
  });
});

describe("buildPersistableOutcomes", () => {
  test("drops guards with no declared canary (passed === undefined) — AT2", () => {
    const report: CanaryReport = {
      total: 2,
      passed: 1,
      failed: 0,
      missing: 1,
      allPassed: true,
      results: [
        makeResult({ guardName: "has-canary", passed: true }),
        makeResult({ guardName: "no-canary", passed: undefined, expects: undefined }),
      ],
    };
    const outcomes = buildPersistableOutcomes(report);
    expect(outcomes.map((o) => o.guardName)).toEqual(["has-canary"]);
  });

  test("carries source/expects/passed/failureDetail through for pass and fail alike", () => {
    const report: CanaryReport = {
      total: 2,
      passed: 1,
      failed: 1,
      missing: 0,
      allPassed: false,
      results: [
        makeResult({ guardName: "guard-pass", source: "registry", expects: "deny", passed: true }),
        makeResult({
          guardName: "guard-fail",
          source: "standalone",
          expects: "warn",
          passed: false,
          error: "run() threw",
        }),
      ],
    };
    const outcomes = buildPersistableOutcomes(report);
    expect(outcomes).toEqual([
      {
        guardName: "guard-pass",
        source: "registry",
        expects: "deny",
        passed: true,
        failureDetail: null,
      },
      {
        guardName: "guard-fail",
        source: "standalone",
        expects: "warn",
        passed: false,
        failureDetail: "run() threw",
      },
    ]);
  });

  test("empty results -> empty outcomes", () => {
    const report: CanaryReport = {
      total: 0,
      passed: 0,
      failed: 0,
      missing: 0,
      allPassed: true,
      results: [],
    };
    expect(buildPersistableOutcomes(report)).toEqual([]);
  });
});
