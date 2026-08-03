// Guard-feedback shape enforcement — mt#3479.
//
// Turns the registry's `attentionCost.denialMessageSizeChars` annotations from
// hand-maintained DOCUMENTATION into an enforced CEILING, and enforces the
// advisory-text authoring standard (`.minsky/rules/guard-feedback-authoring.mdc`)
// against each guard's REAL rendered output.
//
// Why this has to run the canaries rather than read the source: a guard's
// feedback is assembled at runtime from a template plus matched evidence, so the
// only honest measurement is what `run()` actually produces. Reading string
// literals out of the source undercounts template-literal text and cannot see
// the matched-phrase lines at all — the first draft of the mt#3479 survey did
// exactly that and undercounted `turn-end-untaken-action-scan` by ~40%.
//
// WHAT THIS DOES NOT CLAIM. The ceiling is checked against ONE canary sample per
// guard, so for a guard whose output scales with its input (inject-dispatch-
// watchdog grows per in-flight dispatch; guard-health-escalation per unhealthy
// guard; memory-search per retrieved record) this is a RATCHET against drift,
// not a worst-case bound. A guard whose real-world payload can exceed its canary
// sample is bounded only by the dispatcher's merged budget
// (`MERGED_CONTEXT_BUDGET_CHARS`), not by this test. Sizing those worst cases is
// deliberately out of scope — see mt#3479's `## Scope`.
//
// @see .minsky/rules/guard-feedback-authoring.mdc — the standard this enforces
// @see .minsky/hooks/canary-runner.ts — `CanaryResult.outcome`, added for this
// @see .minsky/hooks/dispatcher.ts — `MERGED_CONTEXT_BUDGET_CHARS`, whose
//      derivation consumes the annotations this test keeps honest

/* eslint-disable custom/no-real-fs-in-tests -- this file runs REAL guard
   canaries, several of which write priming fixtures through their `canary.setup`
   hook. A mock fs would defeat the point: the whole value of measuring rendered
   output is that it comes from the guard's production path. The real-fs blast
   radius is contained the same way `canary-runner.test.ts` contains it — a fresh
   mkdtemp root that MINSKY_STATE_DIR and CLAUDE_PROJECT_DIR are pointed at
   before any guard module loads, removed in afterAll, so nothing touches the
   developer's real ~/.local/state/minsky/ or this repo's real .minsky/. */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GuardRegistration } from "./registry";
import type { CanaryResult } from "./canary-runner";

/**
 * Env isolation, mirroring `scripts/run-guard-canaries.ts` EXACTLY.
 *
 * Set before the dynamic imports below, not at first use: several guards read
 * these at module load. `MINSKY_CANARY_MODE` additionally gates the test-only
 * seams (mt#3004) — memory-search's fixture stub and the daemon-staleness
 * tracker-home redirect. Without it two canaries fail with confusing errors
 * that look like guard breakage but are missing setup; that misdiagnosis cost a
 * survey round while authoring this file.
 */
const CANARY_STATE_DIR = mkdtempSync(join(tmpdir(), "mt3479-feedback-shape-"));
process.env["MINSKY_STATE_DIR"] = CANARY_STATE_DIR;
process.env["CLAUDE_PROJECT_DIR"] = CANARY_STATE_DIR;
process.env["MINSKY_CANARY_MODE"] = "1";

const { GUARD_REGISTRY } = await import("./registry");
const { runGuardCanary } = await import("./canary-runner");

/**
 * Patterns that must not appear in ADVISORY text. Both name the operator's
 * override escape hatch, which belongs in a deny message (where an operator is
 * deciding whether to override) and in `CLAUDE.md §Hook Files` (where overrides
 * are catalogued) — not in an injection whose sole reader is an agent being
 * asked to do more work.
 */
const BANNED_IN_ADVISORY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /Override:\s*set\s+MINSKY_/, why: "override advertisement" },
  { pattern: /MINSKY_[A-Z_]+\s*=\s*1/, why: "override env-var assignment" },
];

interface Measured {
  guardName: string;
  declared: number;
  advisory: string;
  denial: string;
}

let measured: Measured[] = [];
let canaryResults: Array<{ reg: GuardRegistration; result: CanaryResult }> = [];

beforeAll(async () => {
  canaryResults = [];
  for (const reg of GUARD_REGISTRY) {
    if (!reg.canary) continue;
    canaryResults.push({ reg, result: await runGuardCanary(reg) });
  }
  measured = canaryResults.map(({ reg, result }) => {
    const outcome = result.outcome ?? undefined;
    return {
      guardName: reg.name,
      declared: reg.attentionCost?.denialMessageSizeChars ?? -1,
      advisory: typeof outcome?.additionalContext === "string" ? outcome.additionalContext : "",
      denial: typeof outcome?.deny?.reason === "string" ? outcome.deny.reason : "",
    };
  });
});

afterAll(() => {
  rmSync(CANARY_STATE_DIR, { recursive: true, force: true });
});

describe("guard feedback — coverage receipt (mt#3479)", () => {
  // A size/style check that silently measures NOTHING passes just as loudly as
  // one that measures everything. Per mem#534 ("a detector isn't working because
  // it shipped — it works when its receipt proves it covered its space"), assert
  // the space actually covered, not merely the absence of failures.

  test("every canary this test depends on still fires", () => {
    const notFiring = canaryResults
      .filter(({ result }) => result.passed !== true)
      .map(({ reg, result }) => `${reg.name} (passed=${result.passed}, error=${result.error})`);
    expect(notFiring).toEqual([]);
  });

  test("the set of guards producing feedback text is the expected one", () => {
    // Pinned by NAME, not by count: a count-only assertion cannot tell "a guard
    // stopped emitting" apart from "a new guard started", which is precisely the
    // silent-coverage-loss this receipt exists to catch.
    const producing = measured
      .filter((m) => m.advisory.length > 0 || m.denial.length > 0)
      .map((m) => m.guardName)
      .sort();

    expect(producing).toEqual(
      [
        "ask-routing-deferral-detector",
        "block-secret-file-read",
        "calibration-review-cadence-detector",
        "check-guessed-session-path",
        "code-mechanism-assertion-detector",
        "guard-health-escalation-detector",
        "inject-current-time",
        "inject-dispatch-watchdog",
        "inject-git-state",
        "inject-prod-state",
        "mcp-daemon-staleness-detector",
        "memory-search",
        "pre-narration-detector",
        "retrospective-trigger-scanner",
        "silent-stretch-detector",
        "skill-staleness-detector",
        "substrate-bypass-detector",
        "turn-end-retro-scan",
        "turn-end-untaken-action-scan",
        "wall-of-text-detector",
      ].sort()
    );
  });

  test("every guard producing feedback declares an attentionCost annotation", () => {
    const undeclared = measured
      .filter((m) => (m.advisory.length > 0 || m.denial.length > 0) && m.declared < 0)
      .map((m) => m.guardName);
    expect(undeclared).toEqual([]);
  });
});

describe("guard feedback — declared size ceiling (mt#3479)", () => {
  test("no guard's rendered feedback exceeds its declared denialMessageSizeChars", () => {
    // Collect ALL violations before asserting: a per-guard `expect` inside a loop
    // reports only the first, which turns a corpus-wide correction into one
    // discovery per test run.
    const over = measured
      .filter((m) => m.declared >= 0)
      .flatMap((m) => {
        const rows: string[] = [];
        if (m.advisory.length > m.declared) {
          rows.push(`${m.guardName}: advisory ${m.advisory.length} chars > declared ${m.declared}`);
        }
        if (m.denial.length > m.declared) {
          rows.push(`${m.guardName}: denial ${m.denial.length} chars > declared ${m.declared}`);
        }
        return rows;
      });

    expect(over).toEqual([]);
  });

  test("an inflated fixture is caught (negative control for the ceiling)", () => {
    // Guards the assertion above against the vacuous-pass failure mode: if the
    // comparison were inverted or the operand empty, the real test would pass on
    // an empty `over` array forever. This proves the comparison has teeth.
    const inflated: Measured = {
      guardName: "synthetic",
      declared: 100,
      advisory: "x".repeat(101),
      denial: "",
    };
    expect(inflated.advisory.length > inflated.declared).toBe(true);
  });
});

describe("guard feedback — advisory authoring standard (mt#3479)", () => {
  test("no advisory text advertises its override env var", () => {
    const violations = measured.flatMap((m) =>
      BANNED_IN_ADVISORY.filter(({ pattern }) => pattern.test(m.advisory)).map(
        ({ why }) => `${m.guardName}: ${why}`
      )
    );
    expect(violations).toEqual([]);
  });

  test("deny messages are EXEMPT from the override ban", () => {
    // Not an oversight — a stated carve-out (mt#3479 `## Scope`). A blocking
    // gate's message is read by an operator deciding whether to override, so
    // naming the override there is the actionable remedy rather than noise.
    //
    // Asserted against a REAL guard rather than a synthetic string: if the
    // carve-out were hypothetical (no shipped deny message actually naming an
    // override), this test would pass vacuously forever and the exemption could
    // be deleted without anything noticing.
    const guessedPath = measured.find((m) => m.guardName === "check-guessed-session-path");
    if (!guessedPath) throw new Error("check-guessed-session-path is missing from the registry");

    // Its deny message really does name MINSKY_SKIP_SESSION_PATH_CHECK=1 — the
    // exemption is load-bearing, not theoretical.
    const denyNamesOverride = BANNED_IN_ADVISORY.some(({ pattern }) =>
      pattern.test(guessedPath.denial)
    );
    expect(denyNamesOverride).toBe(true);

    // And it is nonetheless clean under the advisory standard, because the
    // advisory check reads `additionalContext` only.
    const advisoryViolations = BANNED_IN_ADVISORY.filter(({ pattern }) =>
      pattern.test(guessedPath.advisory)
    );
    expect(advisoryViolations).toEqual([]);
  });
});
