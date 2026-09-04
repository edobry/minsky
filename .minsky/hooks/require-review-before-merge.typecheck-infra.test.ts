/**
 * mt#4950 — the `typecheck-infra` merge gate.
 *
 * Split out of `require-review-before-merge.test.ts` rather than appended to it:
 * that file sits at the 1500-line `max-lines` ERROR ceiling (eslint.config.js),
 * and this block pushed it to 1554. Same split rationale as mt#3179's, and the
 * block is self-contained — it depends only on exported functions, not on the
 * parent file's local fixtures.
 */
import { describe, expect, it } from "bun:test";
import {
  BUNDLE_BOOT_SMOKE_CHECK_NAME,
  TYPECHECK_INFRA_CHECK_NAME,
  TYPECHECK_INFRA_OVERRIDE_ENV,
  evaluateTypecheckInfraConclusion,
  parseBundleBootSmokeResponse,
} from "./require-review-before-merge";

describe("evaluateTypecheckInfraConclusion (mt#4950)", () => {
  const pr = "1234";
  const headSha = "abcdef0123456789abcdef0123456789abcdef01";
  const run = (status: string, conclusion: string | null) => ({
    ok: true as const,
    runs: [
      {
        name: TYPECHECK_INFRA_CHECK_NAME,
        status,
        conclusion,
        htmlUrl: "https://github.com/edobry/minsky/actions/runs/1/job/2",
        startedAt: "2026-09-04T08:00:00Z",
        completedAt: conclusion ? "2026-09-04T08:05:00Z" : null,
      },
    ],
  });

  it("denies when the check concluded failure — the mt#4950 condition", () => {
    const result = evaluateTypecheckInfraConclusion(run("completed", "failure"), pr, headSha);
    expect(result.deny).toBe(true);
    // The message must say what a red check MEANS here, because the job name
    // implies a type error and the actual cause is that no typecheck ran.
    expect(result.reason).toContain("NOT being");
    expect(result.reason).toContain(TYPECHECK_INFRA_OVERRIDE_ENV);
  });

  it("denies on other non-success conclusions too (timed_out, cancelled)", () => {
    for (const conclusion of ["timed_out", "cancelled", "action_required"]) {
      const result = evaluateTypecheckInfraConclusion(run("completed", conclusion), pr, headSha);
      expect(result.deny).toBe(true);
      expect(result.reason).toContain(conclusion);
    }
  });

  it("passes on success", () => {
    expect(evaluateTypecheckInfraConclusion(run("completed", "success"), pr, headSha).deny).toBe(
      false
    );
  });

  it("passes on skipped and neutral — GitHub uses these for jobs that did not run", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      expect(evaluateTypecheckInfraConclusion(run("completed", conclusion), pr, headSha).deny).toBe(
        false
      );
    }
  });

  // The three cases below are where this gate DELIBERATELY diverges from
  // `evaluateBundleBootSmokePresence`, which denies on all of them. Asserting
  // the divergence keeps a later "make it consistent with the bundle gate"
  // refactor from silently widening the blast radius — see the function's
  // docblock for why absence is not this gate's condition.
  it("passes when no typecheck-infra run exists (absent is NOT a denial here)", () => {
    expect(evaluateTypecheckInfraConclusion({ ok: true, runs: [] }, pr, headSha).deny).toBe(false);
  });

  it("passes while the check is still in progress", () => {
    expect(evaluateTypecheckInfraConclusion(run("in_progress", null), pr, headSha).deny).toBe(
      false
    );
  });

  it("passes when the check-runs response could not be parsed", () => {
    expect(
      evaluateTypecheckInfraConclusion({ ok: false, error: "gh api exited 1" }, pr, headSha).deny
    ).toBe(false);
  });

  it("parseBundleBootSmokeResponse filters to typecheck-infra when given the name", () => {
    // Same shared response the gate reads; the name argument is what separates
    // this gate's runs from the bundle gate's.
    const stdout = JSON.stringify({
      check_runs: [
        { name: "bundle-boot-smoke", status: "completed", conclusion: "success" },
        { name: TYPECHECK_INFRA_CHECK_NAME, status: "completed", conclusion: "failure" },
        // GitHub's "<workflow> / <job>" naming variant must match too.
        { name: `CI / ${TYPECHECK_INFRA_CHECK_NAME}`, status: "completed", conclusion: "failure" },
      ],
    });
    const parsed = parseBundleBootSmokeResponse(
      { exitCode: 0, stdout, stderr: "" },
      TYPECHECK_INFRA_CHECK_NAME
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.runs.length).toBe(2);
      expect(parsed.runs.every((r) => r.name.includes(TYPECHECK_INFRA_CHECK_NAME))).toBe(true);
    }
  });

  it("the default check name is unchanged — pre-existing callers still get bundle-boot-smoke", () => {
    const stdout = JSON.stringify({
      check_runs: [
        { name: "bundle-boot-smoke", status: "completed", conclusion: "success" },
        { name: TYPECHECK_INFRA_CHECK_NAME, status: "completed", conclusion: "failure" },
      ],
    });
    const parsed = parseBundleBootSmokeResponse({ exitCode: 0, stdout, stderr: "" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.runs.length).toBe(1);
      expect(parsed.runs[0]?.name).toBe(BUNDLE_BOOT_SMOKE_CHECK_NAME);
    }
  });
});
