/**
 * Tests for the "does this need me?" derivation (mt#3097).
 *
 * These pin the RULE ORDER, which is the actual product decision — most-urgent
 * first, with terminal states settling before anything else can raise an alarm.
 */
import { describe, test, expect } from "bun:test";
import { deriveNeedsYou, failingCheckNames } from "./changeset-status";
import type { ChangesetChecksSummary } from "../../session-detail";

function checks(over: Partial<ChangesetChecksSummary> = {}): ChangesetChecksSummary {
  return {
    allPassed: true,
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    checks: [
      { name: "build", status: "completed", conclusion: "success", url: null },
      { name: "smoke", status: "completed", conclusion: "success", url: null },
    ],
    ...over,
  };
}

const failingChecks = checks({
  allPassed: false,
  passed: 1,
  failed: 1,
  checks: [
    { name: "build", status: "completed", conclusion: "failure", url: null },
    { name: "smoke", status: "completed", conclusion: "success", url: null },
  ],
});

describe("deriveNeedsYou — terminal states settle first", () => {
  test("merged is settled", () => {
    const r = deriveNeedsYou({ state: "merged", approved: true, checks: checks() });
    expect(r.level).toBe("settled");
    expect(r.headline).toBe("Merged");
  });

  test("closed is settled", () => {
    expect(deriveNeedsYou({ state: "closed", approved: null, checks: null }).level).toBe("settled");
  });

  /**
   * A red check on an ALREADY-MERGED PR is history, not a demand. If this
   * inverted, every merged PR with a flaky post-merge check would shout.
   */
  test("a merged PR with failing CI is still settled, not an alarm", () => {
    const r = deriveNeedsYou({ state: "merged", approved: true, checks: failingChecks });
    expect(r.level).toBe("settled");
    expect(r.headline).toBe("Merged");
  });
});

describe("deriveNeedsYou — failing CI outranks review state", () => {
  test("failing CI needs you and names the check", () => {
    const r = deriveNeedsYou({ state: "open", approved: true, checks: failingChecks });
    expect(r.level).toBe("needs-you");
    expect(r.headline).toBe("CI failing");
    expect(r.note).toContain("build");
  });

  test("failing CI wins even when the reviewer requested changes", () => {
    const r = deriveNeedsYou({ state: "open", approved: false, checks: failingChecks });
    expect(r.headline).toBe("CI failing");
  });

  test("multiple failures are counted in the headline", () => {
    const two = checks({
      allPassed: false,
      passed: 0,
      failed: 2,
      checks: [
        { name: "build", status: "completed", conclusion: "failure", url: null },
        { name: "smoke", status: "completed", conclusion: "timed_out", url: null },
      ],
    });
    expect(deriveNeedsYou({ state: "open", approved: true, checks: two }).headline).toBe(
      "CI failing — 2 checks"
    );
  });
});

describe("deriveNeedsYou — waiting states", () => {
  test("awaiting reviewer approval when not approved", () => {
    const r = deriveNeedsYou({ state: "open", approved: false, checks: checks() });
    expect(r.level).toBe("waiting");
    expect(r.headline).toBe("Awaiting reviewer approval");
  });

  test("a draft is never solicited for merge", () => {
    const r = deriveNeedsYou({ state: "draft", approved: true, checks: checks() });
    expect(r.level).toBe("waiting");
    expect(r.headline).toContain("Draft");
  });

  test("running CI is waiting, not needing", () => {
    const running = checks({ allPassed: false, passed: 1, pending: 1, total: 2 });
    const r = deriveNeedsYou({ state: "open", approved: true, checks: running });
    expect(r.level).toBe("waiting");
    expect(r.headline).toBe("CI running");
  });

  test("no review yet and nothing failing is waiting", () => {
    const r = deriveNeedsYou({ state: "open", approved: null, checks: checks() });
    expect(r.level).toBe("waiting");
    expect(r.headline).toBe("Awaiting review");
  });
});

describe("deriveNeedsYou — the merge is the principal's move", () => {
  test("approved + green needs you, with no qualifier", () => {
    const r = deriveNeedsYou({ state: "open", approved: true, checks: checks() });
    expect(r.level).toBe("needs-you");
    expect(r.headline).toBe("Awaiting your merge");
    expect(r.note).toBeUndefined();
  });

  /**
   * Honest-over-lively: an unobserved CI state must be disclosed rather than
   * folded into a confident merge-ready verdict.
   */
  test("approved with UNKNOWN ci discloses that CI was not observed", () => {
    const r = deriveNeedsYou({ state: "open", approved: true, checks: null });
    expect(r.level).toBe("needs-you");
    expect(r.headline).toBe("Awaiting your merge");
    expect(r.note).toBe("CI state unknown");
  });
});

describe("failingCheckNames", () => {
  test("returns only genuinely failing checks", () => {
    expect(failingCheckNames(failingChecks)).toEqual(["build"]);
  });

  test("treats neutral and skipped as passing", () => {
    const c = checks({
      checks: [
        { name: "a", status: "completed", conclusion: "neutral", url: null },
        { name: "b", status: "completed", conclusion: "skipped", url: null },
      ],
    });
    expect(failingCheckNames(c)).toEqual([]);
  });

  test("does not count still-running checks as failures", () => {
    const c = checks({
      checks: [{ name: "a", status: "in_progress", conclusion: null, url: null }],
    });
    expect(failingCheckNames(c)).toEqual([]);
  });

  test("returns empty for unknown check state", () => {
    expect(failingCheckNames(null)).toEqual([]);
  });
});
