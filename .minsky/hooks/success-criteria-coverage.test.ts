#!/usr/bin/env bun
/**
 * Acceptance tests for mt#3350's `## Success Criteria` cross-reference.
 *
 * Numbered to the SPEC's own acceptance tests (1-7), per the mt#3200 authoring convention —
 * a test file that renumbers cannot be lined up with the criteria it claims to cover.
 *
 * Acceptance test 6 spawns the injection hook as a REAL subprocess. Its `minsky tasks spec
 * get` call is stubbed at the PROCESS boundary with a PATH shim rather than by injecting a
 * fake into the module: the thing under test is the `if (import.meta.main)` entry point, which
 * a module-level import never exercises. This works because `execWithPath` prepends only
 * `/opt/homebrew/bin` and `/usr/local/bin` ahead of `process.env.PATH`, and `minsky` lives in
 * `~/.bun/bin` — verified before relying on it, not assumed.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- acceptance test 6 spawns the real hook as a subprocess, which needs a real PATH shim directory on disk; same justification as merge-gate-task-resolution.test.ts
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- same: a real OS temp dir is required for the subprocess spawn
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSuccessCriteria,
  extractSuccessCriteriaSection,
  isExecutableSuccessCriterion,
  checkSuccessCriteriaCoverage,
  findScHeadingNumbers,
  extractScDeferralMarker,
  runScCoverageCalibration,
  SC_COVERAGE_SKIP_ENV_VAR,
} from "./success-criteria-coverage";
import { buildSuccessCriteriaContext } from "./inject-success-criteria";

// ---------------------------------------------------------------------------
// Shared fixtures (custom/no-magic-string-duplication)
// ---------------------------------------------------------------------------

const TASK_ID = "mt#3350";
const PR_NUMBER = 4242;
const GREP_CRITERION = "A repo-wide `grep '<select' src/cockpit/web` returns zero hits.";
const COUNT_CRITERION = "After the sweep, `wc -l` on the report shows the count is 0.";
const JUDGMENT_CRITERION = "The control renders with cockpit surface tokens.";
const SECOND_JUDGMENT = "The panel elevation reads correctly in dark mode.";
const EVIDENCE_HEADING = "Execution evidence:";

/** A spec whose criterion 1 is executable and criterion 2 is judgment-shaped. */
const SPEC_WITH_EXECUTABLE = `# A task

## Summary

Something.

## Success Criteria

- [ ] ${GREP_CRITERION}
- [ ] ${JUDGMENT_CRITERION}

## Scope

In scope: things.
`;

/** A spec whose criteria are ALL judgment-shaped — the negative control. */
const SPEC_ALL_JUDGMENT = `## Success Criteria

- [ ] ${JUDGMENT_CRITERION}
- [ ] ${SECOND_JUDGMENT}

## Scope

Out of scope: nothing.
`;

/** Two executable criteria, so per-criterion scoping is observable. */
const SPEC_TWO_EXECUTABLE = `## Success Criteria

- [ ] ${GREP_CRITERION}
- [ ] ${COUNT_CRITERION}

## Acceptance Tests

1. Something.
`;

// ---------------------------------------------------------------------------
// Acceptance test 4 — the negative control, first because everything rests on it
// ---------------------------------------------------------------------------

describe("AT4: judgment-shaped criteria are not classified executable", () => {
  test("a spec of pure prose criteria yields zero executable criteria and no warning", () => {
    const criteria = parseSuccessCriteria(SPEC_ALL_JUDGMENT);
    expect(criteria).toHaveLength(2);
    expect(criteria.every((c) => !isExecutableSuccessCriterion(c.text))).toBe(true);

    const coverage = checkSuccessCriteriaCoverage(SPEC_ALL_JUDGMENT, "no evidence at all", "");
    expect(coverage.applicable).toBe(false);
    expect(coverage.unaddressedCriteria).toHaveLength(0);
  });

  test("the classifier's default is NON-executable, unlike the AT classifier", () => {
    // The load-bearing inversion (mt#3350 Success Criterion 2). `isExecutableAcceptanceTest`
    // defaults everything executable and subtracts findings-shaped text; copying that here
    // would flag nearly every criterion, since a criteria list is mostly prose. A criterion
    // must POSITIVELY match a command-plus-expected-result shape.
    expect(isExecutableSuccessCriterion("The implementation is correct and well tested.")).toBe(
      false
    );
    expect(isExecutableSuccessCriterion("Ships log-only per the mt#2263 ladder.")).toBe(false);
    expect(isExecutableSuccessCriterion(JUDGMENT_CRITERION)).toBe(false);
  });

  test("recognizes the executable shapes the spec enumerates", () => {
    expect(isExecutableSuccessCriterion(GREP_CRITERION)).toBe(true);
    expect(isExecutableSuccessCriterion(COUNT_CRITERION)).toBe(true);
    expect(isExecutableSuccessCriterion("Run `rg TODO src/` — returns no matches.")).toBe(true);
    expect(isExecutableSuccessCriterion("$ bun run verify\nexit code 0")).toBe(true);
  });

  test("a command with NO expected result is not executable (PR #2432 R1)", () => {
    // Both halves are required. A criterion naming a command but no expected outcome is not
    // self-settling — you can run it, but nothing says which answer passes. The reviewer
    // flagged the `$ <cmd>` case; the backticked-command shape had the same gap, so both are
    // asserted here rather than just the reported instance.
    expect(isExecutableSuccessCriterion("$ bun test")).toBe(false);
    expect(isExecutableSuccessCriterion("Run `grep -r TODO src/` before shipping.")).toBe(false);
    // And a stated result with no command is equally unrunnable.
    expect(isExecutableSuccessCriterion("The dashboard looks right and the count is fine.")).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance tests 1 & 2 — unaddressed warns, addressed does not
// ---------------------------------------------------------------------------

describe("AT1/AT2: an executable criterion must be addressed by the evidence block", () => {
  test("AT1: evidence omitting the command logs a record and warns, naming the criterion", () => {
    const prBody = `## Summary\n\nDid the thing.\n\n${EVIDENCE_HEADING}\n\n\`\`\`\n$ bun test\n12 pass\n\`\`\``;
    const result = runScCoverageCalibration(
      TASK_ID,
      PR_NUMBER,
      SPEC_WITH_EXECUTABLE,
      prBody,
      prBody
    );

    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("SC1");
    expect(result.warning).toContain("not addressed");
    // Log-only: the warning must say so, so a reader does not think the merge was blocked.
    expect(result.warning).toContain("Merge is NOT blocked");

    expect(result.calibrationRecord).toBeDefined();
    expect(result.calibrationRecord?.task).toBe(TASK_ID);
    expect(result.calibrationRecord?.prNumber).toBe(PR_NUMBER);
    expect(result.calibrationRecord?.executableCriterionCount).toBe(1);
    const unaddressed = result.calibrationRecord?.unaddressedCriteria as Array<{ number: number }>;
    expect(unaddressed.map((c) => c.number)).toEqual([1]);
  });

  test("AT2: evidence containing the command and its zero output produces no warning", () => {
    const prBody = `${EVIDENCE_HEADING}\n\n\`\`\`\n$ grep -r '<select' src/cockpit/web | wc -l\n0\n\`\`\``;
    const result = runScCoverageCalibration(
      TASK_ID,
      PR_NUMBER,
      SPEC_WITH_EXECUTABLE,
      prBody,
      prBody
    );

    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.calibrationRecord).toBeUndefined();
  });

  test("the skip env var turns the whole surface off", () => {
    const prBody = "no evidence here";
    const result = runScCoverageCalibration(TASK_ID, PR_NUMBER, SPEC_WITH_EXECUTABLE, prBody, "", {
      [SC_COVERAGE_SKIP_ENV_VAR]: "1",
    });
    expect(result.ranCheck).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  test("the AT override does NOT silence this surface (PR #2432 R2)", () => {
    // The two surfaces have separate documented overrides, so setting one must not disable the
    // other. The first wiring coupled them: the entry point read the spec back out of the AT
    // calibration's result, and `MINSKY_SKIP_AT_COVERAGE=1` returned early with no spec — so
    // the acceptance-test override silently disabled success-criteria coverage too. The entry
    // point now fetches the spec itself and drives both surfaces from it; this pins the half of
    // that guarantee a unit test can hold.
    const prBody = "no evidence here";
    const result = runScCoverageCalibration(TASK_ID, PR_NUMBER, SPEC_WITH_EXECUTABLE, prBody, "", {
      MINSKY_SKIP_AT_COVERAGE: "1",
    });
    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("SC1");
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 3 — the deferral marker is PER-CRITERION
// ---------------------------------------------------------------------------

describe("AT3: [scN-deferred: mt#NNNN] is scoped to one criterion", () => {
  const bareBody = "## Summary\n\nNothing addressed.";

  test("a marker for criterion 1 suppresses only criterion 1's warning", () => {
    const body = `${bareBody}\n\n[sc1-deferred: mt#9999]`;
    const coverage = checkSuccessCriteriaCoverage(SPEC_TWO_EXECUTABLE, body, "");

    expect(coverage.executableCriteria).toHaveLength(2);
    // Criterion 2 is still unaddressed — the marker did not excuse the list.
    expect(coverage.unaddressedCriteria.map((c) => c.number)).toEqual([2]);
    expect(extractScDeferralMarker(body, 1)).toBe("mt#9999");
  });

  test("a marker for a DIFFERENT criterion does NOT suppress criterion 1", () => {
    // The direction that a bare `[sc-deferred: ...]` would have gotten wrong: one marker
    // excusing an entire list is exactly the "prose reads as coverage" failure the numbered
    // marker convention exists to prevent.
    const body = `${bareBody}\n\n[sc2-deferred: mt#9999]`;
    const coverage = checkSuccessCriteriaCoverage(SPEC_TWO_EXECUTABLE, body, "");

    expect(coverage.unaddressedCriteria.map((c) => c.number)).toEqual([1]);
    expect(extractScDeferralMarker(body, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 5 — fence-aware extraction
// ---------------------------------------------------------------------------

describe("AT5: extraction is fence-aware and does not misparse", () => {
  test("a `## Success Criteria` heading immediately followed by a fence", () => {
    // PR #2386 R1's boundary case, inherited from the AT path: the heading's own newline is
    // consumed by the heading match, so a naive `\n##` lookahead over-captures past an empty
    // section into whatever follows.
    const spec = "## Success Criteria\n```\nnot a criterion\n```\n\n### Covers\n\n- a bullet\n";
    const section = extractSuccessCriteriaSection(spec);
    expect(section).not.toBeNull();
    // `### Covers` is a DEEPER heading and must end the section — otherwise its bullets get
    // swept in as criteria (the mt#3117 / PR #2234 shape: 10 "ATs" reported against a spec
    // declaring 4).
    expect(section).not.toContain("a bullet");
  });

  test("an executable-looking string inside a fence in an unrelated section is not a criterion", () => {
    const spec = `## Success Criteria

- [ ] ${JUDGMENT_CRITERION}

## Notes

\`\`\`
- [ ] a repo-wide grep returns zero hits
\`\`\`
`;
    const criteria = parseSuccessCriteria(spec);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.text).toBe(JUDGMENT_CRITERION);
    expect(isExecutableSuccessCriterion(criteria[0]?.text ?? "")).toBe(false);
  });

  test("an SC-heading-looking line inside a fence does not count as an SC section", () => {
    const body = "## Summary\n\n```\n## SC3 — this is pasted example markdown\n```\n";
    expect(findScHeadingNumbers(body).has(3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 7 — `SC<N>` headings (the mt#3339 boundary)
// ---------------------------------------------------------------------------

describe("AT7: a dedicated SC<N> section addresses that criterion", () => {
  test("evidence under an `## SC1` heading addresses criterion 1", () => {
    // The real-world shape is mt#3149 / PR #2255, whose body carries
    // `## SC3 (...) — re-verified, closed as already-resolved`. The AT-path scanner could not
    // see it; recognizing it is this task's half of FP-4 per the mt#3339 boundary.
    const body = "## SC1 (grep for `<select`) — re-verified\n\nRan it; 0 hits.\n";
    const coverage = checkSuccessCriteriaCoverage(SPEC_WITH_EXECUTABLE, body, "");

    expect(coverage.applicable).toBe(true);
    expect(coverage.unaddressedCriteria).toHaveLength(0);
  });

  test("recognizes the `SC#N` and deeper-heading spellings, and only the numbered ones", () => {
    expect(findScHeadingNumbers("### SC#2 — evidence\n").has(2)).toBe(true);
    expect(findScHeadingNumbers("## SC 5 — evidence\n").has(5)).toBe(true);
    // `## Testing` and `## Design/Approach` are mt#3339's half, deliberately NOT matched here.
    expect(findScHeadingNumbers("## Testing\n\nstuff\n").size).toBe(0);
    expect(findScHeadingNumbers("## Scope\n\nstuff\n").size).toBe(0);
  });

  test("an SC section for a DIFFERENT criterion leaves this one unaddressed", () => {
    const body = "## SC2 — evidence for the other one\n\nRan it.\n";
    const coverage = checkSuccessCriteriaCoverage(SPEC_TWO_EXECUTABLE, body, "");
    expect(coverage.unaddressedCriteria.map((c) => c.number)).toEqual([1]);
  });
});

// mt#3339: the absent-vs-present-elsewhere partition, mirrored onto this surface per
// mt#3566's design note 2. This surface had produced ZERO calibration records when mt#3339
// was planned, so the field ships now to make its rate measurable PROSPECTIVELY — a field
// added after the corpus accumulates cannot retro-classify it.
describe("present-elsewhere classification (mt#3339)", () => {
  test("classifies a criterion as present-elsewhere when its number appears outside the evidence", () => {
    // `SC1` is referenced in the body but NOT in the evidence text the gate reads, and not
    // under an `SC<N>` heading — so it stays unaddressed, and is recorded as a location gap.
    const body = "## Notes\n\nSC1 was checked by hand during review.\n";
    const coverage = checkSuccessCriteriaCoverage(SPEC_WITH_EXECUTABLE, body, "");

    expect(coverage.unaddressedCriteria.map((c) => c.number)).toEqual([1]);
    expect(coverage.presentElsewhereCriteria.map((c) => c.number)).toEqual([1]);
  });

  test("classifies a criterion as absent when its number appears nowhere", () => {
    const body = "## Notes\n\nNothing relevant here.\n";
    const coverage = checkSuccessCriteriaCoverage(SPEC_WITH_EXECUTABLE, body, "");

    expect(coverage.unaddressedCriteria.map((c) => c.number)).toEqual([1]);
    expect(coverage.presentElsewhereCriteria).toEqual([]);
  });

  test("an addressed criterion appears in neither list", () => {
    const body = "## SC1 — evidence\n\nRan it; 0 hits.\n";
    const coverage = checkSuccessCriteriaCoverage(SPEC_WITH_EXECUTABLE, body, "");

    expect(coverage.unaddressedCriteria).toEqual([]);
    expect(coverage.presentElsewhereCriteria).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 6 — the injection actually fires
// ---------------------------------------------------------------------------

describe("AT6: session_pr_create injection", () => {
  test("the built context carries the criteria section verbatim", () => {
    const context = buildSuccessCriteriaContext(TASK_ID, SPEC_WITH_EXECUTABLE);
    expect(context).not.toBeNull();
    expect(context).toContain(GREP_CRITERION);
    expect(context).toContain(JUDGMENT_CRITERION);
    expect(context).toContain(TASK_ID);
    // It must tell the reader what to DO, not merely restate the criteria.
    expect(context).toContain("[scN-deferred:");
  });

  test("a spec with no `## Success Criteria` section injects nothing", () => {
    expect(buildSuccessCriteriaContext(TASK_ID, "## Summary\n\nNo criteria here.\n")).toBeNull();
  });

  test("an empty criteria section injects nothing", () => {
    expect(
      buildSuccessCriteriaContext(TASK_ID, "## Success Criteria\n\n## Scope\n\nx\n")
    ).toBeNull();
  });
});

describe("AT6: the injection hook FIRES as a real process", () => {
  let shimDir: string;
  let repoDir: string;

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), "mt3350-shim-"));

    repoDir = mkdtempSync(join(tmpdir(), "mt3350-repo-"));

    const payload = JSON.stringify({ success: true, content: SPEC_WITH_EXECUTABLE });
    // A `minsky` that answers `tasks spec get` with canned JSON and ignores everything else.
    const shim = `#!/bin/sh\ncat <<'MT3350_EOF'\n${payload}\nMT3350_EOF\n`;
    // eslint-disable-next-line custom/no-real-fs-in-tests -- writing the executable stub itself
    writeFileSync(join(shimDir, "minsky"), shim);

    chmodSync(join(shimDir, "minsky"), 0o755);

    for (const args of [
      ["init", "-q", "-b", "task/mt-3350"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["commit", "-q", "--allow-empty", "-m", "init"],
    ]) {
      const r = Bun.spawnSync(["git", ...args], { cwd: repoDir });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    }
  });

  afterAll(() => {
    for (const d of [shimDir, repoDir]) {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup of the real dirs above
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test("emits the criteria as additionalContext on a real session_pr_create input", () => {
    // Asserts the injection FIRED and carried the section text — not merely that the hook
    // exited 0, which a completely dead hook would also do.
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "inject-success-criteria.ts")], {
      stdin: Buffer.from(
        JSON.stringify({
          session_id: "00000000-0000-4000-8000-00000000000a",
          tool_name: "mcp__minsky__session_pr_create",
          tool_input: {},
          cwd: repoDir,
        })
      ),
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    });

    const stdout = result.stdout.toString();
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(GREP_CRITERION);
    // The task id came from the branch fallback, so a sessionId-invoked PR creation is covered.
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(TASK_ID);
  });

  test("stays silent when no task id resolves", () => {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "inject-success-criteria.ts")], {
      stdin: Buffer.from(
        JSON.stringify({
          session_id: "00000000-0000-4000-8000-00000000000b",
          tool_name: "mcp__minsky__session_pr_create",
          tool_input: {},
          cwd: shimDir,
        })
      ),
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.stdout.toString().trim()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
