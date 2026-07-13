/**
 * Tests for `trimChecksResult` (mt#2656): the checks-payload trim used by
 * `session.pr.drive`'s convergence-tail mode. Pure function — no session
 * resolution or backend involved, so these are plain unit tests.
 */
import { describe, expect, test } from "bun:test";
import { trimChecksResult } from "./pr-checks-subcommand";
import type { ChecksResult } from "../../repository/index";

describe("trimChecksResult (mt#2656)", () => {
  test("drops the per-check breakdown when all checks passed", () => {
    const result: ChecksResult = {
      allPassed: true,
      summary: { total: 3, passed: 3, failed: 0, pending: 0 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "success", url: null },
        { name: "lint", status: "completed", conclusion: "neutral", url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed).toEqual({ allPassed: true, summary: result.summary });
    expect("checks" in trimmed).toBe(false);
    expect("failingChecks" in trimmed).toBe(false);
  });

  test("surfaces only the failing check when one of several checks failed", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 2, passed: 1, failed: 1, pending: 0 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "failure", url: "https://ci/test" },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.allPassed).toBe(false);
    expect(trimmed.summary).toEqual(result.summary);
    expect(trimmed.failingChecks).toEqual([
      { name: "test", status: "completed", conclusion: "failure", url: "https://ci/test" },
    ]);
  });

  test("surfaces pending (incomplete) checks in failingChecks alongside failed ones", () => {
    const result: ChecksResult = {
      allPassed: false,
      timedOut: true,
      summary: { total: 3, passed: 1, failed: 1, pending: 1 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "failure", url: null },
        { name: "deploy", status: "in_progress", conclusion: null, url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.timedOut).toBe(true);
    expect(trimmed.failingChecks).toHaveLength(2);
    expect(trimmed.failingChecks?.map((c) => c.name).sort()).toEqual(["deploy", "test"]);
  });

  test("treats neutral and skipped conclusions as passing, not failing", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 3, passed: 2, failed: 1, pending: 0 },
      checks: [
        { name: "neutral-check", status: "completed", conclusion: "neutral", url: null },
        { name: "skipped-check", status: "completed", conclusion: "skipped", url: null },
        { name: "failed-check", status: "completed", conclusion: "failure", url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.failingChecks).toEqual([
      { name: "failed-check", status: "completed", conclusion: "failure", url: null },
    ]);
  });

  test("does not set timedOut when the source result did not time out", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 1, passed: 0, failed: 1, pending: 0 },
      checks: [{ name: "test", status: "completed", conclusion: "failure", url: null }],
    };
    const trimmed = trimChecksResult(result);
    expect("timedOut" in trimmed).toBe(false);
  });

  test("empty checks array with allPassed:false yields an empty failingChecks array", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 0, passed: 0, failed: 0, pending: 0 },
      checks: [],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.failingChecks).toEqual([]);
  });
});
