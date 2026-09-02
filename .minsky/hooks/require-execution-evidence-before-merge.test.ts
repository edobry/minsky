/* eslint-disable max-lines -- comprehensive merge-gate test suite covering every accepted/
   rejected marker-form permutation across several review rounds (mt#2648, mt#3033, mt#3350,
   mt#3530, mt#3968); the file sits at the repo's line-count ceiling from legitimate coverage
   growth, not bloat, and splitting it is a separate refactor, out of scope for a review round. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// mt#4755: the READER's own resolver, so the location assertion below cannot drift from where
// the writer actually writes. `tests/setup.ts` points both state-dir env vars at a temp root,
// so this resolves inside test isolation rather than the operator's real state dir.
import { calibrationLogPath } from "./dispatcher";
/* eslint-disable custom/no-real-fs-in-tests -- the `runAtCoverageCalibration` /
   `appendAtCoverageCalibration` regression tests below exercise the real, unmocked
   calibration-log write path (mirrors `guard-health-write-isolation.test.ts`'s
   rationale) against a real mkdtemp scratch directory — a real-fs round-trip is the
   point of that suite, not something injectable-fs mocking can substitute for. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "node:path";

import {
  isTestFile,
  isOperationalScript,
  findNewTestFiles,
  findNewOperationalScripts,
  hasExecutionEvidence,
  hasBypassPrefix,
  checkExecutionEvidence,
  parseGitHubRemoteUrl,
  resolvePrNumber,
  type PrFile,
  type FetchPrFilesResult,
  type ExecFn,
  // mt#3033: AT-cross-reference (calibration-first)
  extractAcceptanceTestsSection,
  parseAcceptanceTests,
  isFindingsShapedAcceptanceTest,
  isExecutableAcceptanceTest,
  extractExecutionEvidenceText,
  isAtReferencedByNumber,
  isAtReferencedByKeyword,
  extractAtDeferralMarker,
  isAtDeferred,
  checkAcceptanceTestCoverage,
  isAtCoverageSkipped,
  // mt#4755: the stream name the writer now passes to `logCalibrationRecord`.
  AT_COVERAGE_STREAM,
  AT_COVERAGE_SKIP_ENV_VAR,
  fetchTaskSpecForAtCoverage,
  runAtCoverageCalibration,
  type AcceptanceTestItem,
  type AtCoverageResult,
} from "./require-execution-evidence-before-merge";

// ---------------------------------------------------------------------------
// Shared test fixtures — hoisted to avoid magic-string-duplication warnings
// ---------------------------------------------------------------------------

/** Canonical source file fixture (not a test file) */
const FIXTURE_FOO_TS = "src/domain/foo.ts";
/** Canonical test file fixture (.test.ts) */
const FIXTURE_FOO_TEST_TS = "src/domain/foo.test.ts";
/** A second test file fixture (.spec.ts) */
const FIXTURE_A_TEST_TS = "src/domain/a.test.ts";
/** A third test file fixture (.spec.ts) */
const FIXTURE_B_SPEC_TS = "src/domain/b.spec.ts";
/** An integration test fixture */
const FIXTURE_INTEGRATION_TEST_TS = "tests/integration/foo.integration.test.ts";
/** A session test fixture for acceptance-test 4 */
const FIXTURE_SESSION_TEST_TS = "src/domain/session.test.ts";
/** A second integration test for multi-file enumeration */
const FIXTURE_SESSION_INTEGRATION_TEST_TS = "tests/integration/session.integration.test.ts";
/** A tasks integration test for multi-file enumeration */
const FIXTURE_TASKS_INTEGRATION_TEST_TS = "tests/integration/tasks.integration.test.ts";

/** Minimal PR body with no execution evidence */
const BODY_NO_EVIDENCE = "## Summary\nSome changes.";
/** PR body with an execution evidence block present */
const BODY_WITH_EVIDENCE = `## Summary\nAdded new feature.\n\n## Execution evidence:\n\`\`\`\nbun test passed\n\`\`\``;
/** PR title that has NO bypass prefix */
const TITLE_PLAIN = "Add new feature and tests";
/** PR title that has the bypass prefix */
const TITLE_BYPASS = "[unverified-tests] Add new tests";
/** PR title for "add integration tests" used in acceptance tests 1 and 2 */
const TITLE_ADD_INTEGRATION = "Add integration tests";

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe("isTestFile", () => {
  it("matches *.test.ts", () => {
    expect(isTestFile("src/domain/session.test.ts")).toBe(true);
    expect(isTestFile("tests/unit/foo.test.ts")).toBe(true);
  });

  it("matches *.integration.test.ts", () => {
    expect(isTestFile("tests/integration/session.integration.test.ts")).toBe(true);
    expect(isTestFile("src/adapters/cli/foo.integration.test.ts")).toBe(true);
  });

  it("matches *.spec.ts", () => {
    expect(isTestFile("src/domain/task.spec.ts")).toBe(true);
    expect(isTestFile("tests/e2e/flow.spec.ts")).toBe(true);
  });

  it("does not match plain .ts files", () => {
    expect(isTestFile("src/domain/session.ts")).toBe(false);
    expect(isTestFile("src/index.ts")).toBe(false);
  });

  it("does not match .test.js files (only .ts)", () => {
    expect(isTestFile("src/foo.test.js")).toBe(false);
  });

  it("does not match files that merely contain 'test' in the name", () => {
    expect(isTestFile("src/domain/testUtils.ts")).toBe(false);
    expect(isTestFile("src/testHelpers.ts")).toBe(false);
  });

  // The `.tsx` cases moved to `./pr-file-predicates.test.ts` when mt#3868 widened the predicate
  // — this file was already at the max-lines ceiling, and the predicate had no test file of its
  // own. A case asserting `isTestFile(".test.tsx") === false` used to live here; mt#3868 reverses
  // it, and that reversal is documented at its new home.
});

// ---------------------------------------------------------------------------
// findNewTestFiles
// ---------------------------------------------------------------------------

describe("findNewTestFiles", () => {
  it("returns added test files", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_FOO_TEST_TS, status: "added" },
      { filename: FIXTURE_FOO_TS, status: "added" },
    ];
    expect(findNewTestFiles(files)).toEqual([FIXTURE_FOO_TEST_TS]);
  });

  it("ignores modified test files (only added counts as new)", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_FOO_TEST_TS, status: "modified" },
      { filename: "src/domain/bar.integration.test.ts", status: "modified" },
    ];
    expect(findNewTestFiles(files)).toHaveLength(0);
  });

  it("ignores deleted test files", () => {
    const files: PrFile[] = [{ filename: "src/domain/old.test.ts", status: "removed" }];
    expect(findNewTestFiles(files)).toHaveLength(0);
  });

  it("returns multiple added test files", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_A_TEST_TS, status: "added" },
      { filename: FIXTURE_B_SPEC_TS, status: "added" },
      { filename: "tests/integration/c.integration.test.ts", status: "added" },
      { filename: "src/domain/d.ts", status: "added" },
    ];
    const result = findNewTestFiles(files);
    expect(result).toHaveLength(3);
    expect(result).toContain(FIXTURE_A_TEST_TS);
    expect(result).toContain(FIXTURE_B_SPEC_TS);
    expect(result).toContain("tests/integration/c.integration.test.ts");
  });

  it("returns empty when no files are provided", () => {
    expect(findNewTestFiles([])).toHaveLength(0);
  });

  it("returns empty when no test files are added", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_FOO_TS, status: "added" },
      { filename: "src/adapters/cli/bar.ts", status: "added" },
    ];
    expect(findNewTestFiles(files)).toHaveLength(0);
  });

  // --- Renamed / copied file detection (SUBSTANTIVE #3 from PR #909 round 5) ---

  it("counts renamed non-test → test file as a new test file", () => {
    // foo-utils.ts renamed to foo-utils.test.ts — new test file introduced
    const files: PrFile[] = [
      {
        filename: "src/domain/foo-utils.test.ts",
        status: "renamed",
        previous_filename: "src/domain/foo-utils.ts",
      },
    ];
    expect(findNewTestFiles(files)).toEqual(["src/domain/foo-utils.test.ts"]);
  });

  it("does NOT count renamed test → test file (just a test relocation)", () => {
    // src/foo.test.ts renamed to tests/foo.test.ts — still a test file, not a new one
    const files: PrFile[] = [
      {
        filename: "tests/foo.test.ts",
        status: "renamed",
        previous_filename: "src/foo.test.ts",
      },
    ];
    expect(findNewTestFiles(files)).toHaveLength(0);
  });

  it("counts copied non-test → test file as a new test file", () => {
    // src/utils.ts copied to tests/utils.test.ts — new test file introduced
    const files: PrFile[] = [
      {
        filename: "tests/utils.test.ts",
        status: "copied",
        previous_filename: "src/utils.ts",
      },
    ];
    expect(findNewTestFiles(files)).toEqual(["tests/utils.test.ts"]);
  });

  it("does NOT count renamed non-test → non-test file", () => {
    const files: PrFile[] = [
      {
        filename: "src/domain/bar.ts",
        status: "renamed",
        previous_filename: "src/domain/foo.ts",
      },
    ];
    expect(findNewTestFiles(files)).toHaveLength(0);
  });

  it("counts renamed test file with no previous_filename (conservative include)", () => {
    // No previous_filename — conservatively treat as new test file
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "renamed" }];
    expect(findNewTestFiles(files)).toEqual([FIXTURE_FOO_TEST_TS]);
  });
});

// ---------------------------------------------------------------------------
// hasExecutionEvidence
// ---------------------------------------------------------------------------

/** The marker under test, extracted so the fence cases below share one spelling. */
const EE_MARKER = "Execution evidence:";

describe("hasExecutionEvidence — fence awareness (mt#3530)", () => {
  // The defect: a PR that merely QUOTES the expected evidence shape satisfied this
  // BLOCKING gate. Both directions are pinned, because only the pair proves the fix
  // discriminates rather than just tightening: a quoted-only marker must fail, and
  // the normal shape (marker outside, run output fenced beneath) must still pass.
  it("does NOT count a marker whose only occurrence is inside a code fence", () => {
    const body = [
      "## Summary",
      "",
      "Reviewers, the expected shape is:",
      "",
      "```markdown",
      EE_MARKER,
      "  bun test ./x -> 12 pass, 0 fail",
      "```",
      "",
      "(That is an example, not this PR's evidence.)",
    ].join("\n");
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("still counts a real marker with its run output fenced BENEATH it", () => {
    // The normal, documented shape. Fenced CONTENT is fine — only a fenced MARKER
    // is quoted text. If this regressed, every well-formed PR would be blocked.
    const body = [
      "## Testing",
      "",
      EE_MARKER,
      "",
      "```",
      "bun test ./x -> 12 pass, 0 fail",
      "```",
    ].join("\n");
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  // NOTE (PR #2533 R1): the content scan here is ALSO fence-gated for consistency with
  // `collectHeadingSections` and `test-first-evidence.ts`, but no test asserts a verdict
  // change from it — because none can. This function returns on the FIRST non-empty line
  // after the marker, and a fence's opening ``` line is itself non-empty, so a
  // fence-internal `#` is unreachable as a truncation point. Measured both ways:
  // unfixed=true, fixed=true. A test pinning it would pass with and without the change
  // and would therefore assert nothing — the exact shape this repo's negative-control
  // discipline rejects. The gating stays as defense against a future refactor that makes
  // it reachable; the honest claim is "consistency", not "fixes a live bug here".
  // The gate where it IS reachable is `hasDeployVerification` — see its test.
  it("still stops at a REAL heading after the marker, so an empty section is empty", () => {
    // This one DOES discriminate on the marker-scan change and guards the section
    // boundary: fence-awareness must not turn "no content" into "content".
    const body = ["## Testing", "", EE_MARKER, "", "## Next section", "", "text"].join("\n");
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("counts a real marker even when an unrelated fence elsewhere quotes one too", () => {
    const body = [
      "## Notes",
      "",
      "```markdown",
      EE_MARKER,
      "  (an example being quoted)",
      "```",
      "",
      EE_MARKER,
      "  bun test ./y -> 3 pass, 0 fail",
    ].join("\n");
    expect(hasExecutionEvidence(body)).toBe(true);
  });
});

// mt#3968: bold/bullet label widening -- mirrors the sibling negative-control matcher
// (mt#3778). Cases map 1:1 to the spec's numbered ATs; negatives are what must NOT flip.
// PR #2854 R2: added AT1b (colon outside bold) and the `*`/`+` bullet forms -- the code
// already accepted all three bullet markers (see BULLET_PREFIX), this locks them in.
describe("hasExecutionEvidence — bolded / bulleted label forms (mt#3968)", () => {
  const cases: [string, string, boolean][] = [
    ["AT1: colon inside bold", "**Execution evidence:**\n\n```\n5 pass\n```", true],
    ["AT1b: colon outside bold", "**Execution evidence**: 5 pass", true],
    ["AT2: bolded + bulleted (-)", "- **Execution evidence:** 5 pass", true],
    ["bulleted (*)", "* **Execution evidence:** 5 pass", true],
    ["bulleted (+)", "+ **Execution evidence:** 5 pass", true],
    ["AT3: bare prose (colon rule)", "we should add execution evidence here", false],
    ["AT4: bolded negation (negation guard)", "**No execution evidence:**\n\ncontent", false],
    ["AT5: bolded marker in a fence (mt#3530)", "## S\n\n```\n**Execution evidence:**\n```", false],
  ];
  it.each(cases)("%s", (_label, body, expected) => {
    expect(hasExecutionEvidence(body)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Marker-form parity (mt#4054)
// ---------------------------------------------------------------------------

/**
 * The ONE table both marker-recognizing functions are asserted against.
 *
 * `hasExecutionEvidence` (the blocking gate) and `extractExecutionEvidenceText` (the
 * AT/SC-coverage search text) build their patterns separately, because mt#3033 requires the
 * blocking one to stay byte-for-byte unchanged. Two independently-maintained fixture lists is
 * how they drifted: mt#3968 widened the gate to accept bold and bulleted labels and left the
 * extractor behind for two weeks, so a PR body using `**Execution evidence:**` satisfied the
 * gate and extracted to `""` — every executable AT in it read as unaddressed regardless of
 * where the evidence sat.
 *
 * Adding a form here asserts it against BOTH. That is the property: a future widening either
 * lands in both functions or fails this test.
 */
const ACCEPTED_MARKER_FORMS: [label: string, body: string, accepted: boolean][] = [
  ["plain label with colon", "Execution evidence: 5 pass", true],
  ["heading, no colon", "## Execution evidence\n\n5 pass", true],
  ["heading, trailing colon", "### Execution evidence:\n\n5 pass", true],
  ["bold, colon inside", "**Execution evidence:**\n\n```\n5 pass\n```", true],
  ["bold, colon outside", "**Execution evidence**: 5 pass", true],
  ["underscore emphasis", "__Execution evidence:__ 5 pass", true],
  ["bulleted (-) + bold", "- **Execution evidence:** 5 pass", true],
  ["bulleted (*) + bold", "* **Execution evidence:** 5 pass", true],
  ["bulleted (+) + bold", "+ **Execution evidence:** 5 pass", true],
  ["bulleted, no emphasis", "- Execution evidence: 5 pass", true],
  ["uppercase", "EXECUTION EVIDENCE: all passed", true],
  // Negatives — what must NOT flip when a form is added above.
  ["bare prose (colon rule)", "we should add execution evidence here", false],
  ["mid-sentence with colon", "This PR lacks execution evidence: none was run", false],
  ["negation", "No Execution evidence: this PR has no tests", false],
  ["bolded negation", "**No execution evidence:**\n\ncontent", false],
  [
    "marker only inside a fence (mt#3530)",
    "## S\n\n```\n**Execution evidence:**\n5 pass\n```",
    false,
  ],
  ["marker in an HTML comment", "## S\n\n<!-- Execution evidence: 5 pass -->", false],
  ["marker with no content beneath", "## Summary\n\nFoo.\n\n## Execution evidence:", false],
];

describe("marker-form parity between the gate and the extractor (mt#4054)", () => {
  it.each(ACCEPTED_MARKER_FORMS)("hasExecutionEvidence — %s", (_label, body, accepted) => {
    expect(hasExecutionEvidence(body)).toBe(accepted);
  });

  it.each(ACCEPTED_MARKER_FORMS)("extractExecutionEvidenceText — %s", (_label, body, accepted) => {
    // Non-empty extraction is the extractor's analogue of the gate's boolean: an empty
    // extraction means the AT/SC scan searches nothing, which is the mt#4054 defect.
    expect(extractExecutionEvidenceText(body).trim().length > 0).toBe(accepted);
  });

  it("extracts the SAME content whether the label is decorated or plain", () => {
    // The discriminating assertion: identical bodies, identical evidence, only the label's
    // markup differs. Pre-fix the bold form yielded "" while the plain form yielded the
    // block — which is how a correctly-authored PR read as having no evidence at all.
    const evidence = ["", "```", "$ bun test ./x", " 12 pass 0 fail", "```"].join("\n");
    const bold = `## Testing\n\n**Execution evidence:**${evidence}`;
    const plain = `## Testing\n\nExecution evidence:${evidence}`;
    expect(extractExecutionEvidenceText(bold)).toBe(extractExecutionEvidenceText(plain));
    expect(extractExecutionEvidenceText(bold)).toContain("12 pass");
  });
});

// PR #2929 (mt#4032) — the originating incident, replayed against its ACTUAL body.
// The gate fired "3 of 3 unaddressed" twice, the second time AFTER the author applied the
// remedy the gate itself prescribed (move the AT references INSIDE the evidence block).
// The remedy could not work: the block was never extracted, because the label was bold.
describe("PR #2929 regression — bold label, ATs inside the block (mt#4054)", () => {
  // Verbatim from mt#4032's spec.
  const SPEC = `## Acceptance Tests

1. \`bun run src/cli.ts compile --check\` passes with the rule under 12,000 chars; the number is
   recorded in this spec.
2. For each entry compressed, its docs page contains the moved text — grep one distinctive
   phrase per move and record the hits.
3. Adding a synthetic 300-char observer entry still passes the per-rule ceiling, demonstrating
   the headroom rather than asserting it.
`;

  // Excerpted from PR #2929's body — the label line and the AT references are byte-for-byte
  // as merged; the pasted command output between them is elided for length.
  const PR_BODY = `## Testing

**Execution evidence:**

\`\`\`
$ bun run src/cli.ts compile --check --target claude.md
      "id": "hook-observers",
      "size": 10765
  "perRuleViolations": [],

=== AT1 — "compile --check passes with the rule under 12,000 chars; the number is recorded in
=== this spec." PASS: 10,765 compiled chars, perRuleViolations: [] (output above).

=== AT2 — "For each entry compressed, its docs page contains the moved text — grep one
=== distinctive phrase per move and record the hits." PASS: 13 of 13 hit.

=== AT3 — "Adding a synthetic 300-char observer entry still passes the per-rule ceiling,
=== demonstrating the headroom rather than asserting it." PASS, run at 434 chars.
\`\`\`
`;

  it("extracts non-empty evidence text", () => {
    expect(extractExecutionEvidenceText(PR_BODY).length).toBeGreaterThan(0);
  });

  it("resolves all three ATs as referenced by number", () => {
    const evidenceText = extractExecutionEvidenceText(PR_BODY);
    const ats = parseAcceptanceTests(SPEC);
    expect(ats).toHaveLength(3);
    for (const at of ats) {
      expect(isAtReferencedByNumber(at, evidenceText)).toBe(true);
    }
  });

  it("reports no unaddressed ATs", () => {
    const coverage = checkAcceptanceTestCoverage(SPEC, "implementation", PR_BODY);
    expect(coverage.applicable).toBe(true);
    expect(coverage.unaddressedAts).toEqual([]);
  });
});

describe("hasExecutionEvidence", () => {
  it("detects '## Execution evidence:' heading with content on next line", () => {
    const body = `## Summary\nSome PR.\n\n## Execution evidence:\nbun test passed\n`;
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  it("detects lowercase variant with inline content", () => {
    expect(hasExecutionEvidence("execution evidence: output here")).toBe(true);
  });

  it("detects mixed case with inline content", () => {
    expect(hasExecutionEvidence("EXECUTION EVIDENCE: all passed")).toBe(true);
  });

  it("detects heading with content block (code fence)", () => {
    const body = `## Summary\nChanges made.\n\n## Execution evidence:\n\`\`\`\nbun test\n1 pass\n\`\`\`\n`;
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  it("returns false when heading is absent", () => {
    const body = `## Summary\nNo tests were run.\n\n## Testing\nUnit tests updated.\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false for empty body", () => {
    expect(hasExecutionEvidence("")).toBe(false);
  });

  // --- Negative cases required by BLOCKING #4 from PR #909 round 1 review ---

  it("returns false for negation: 'No Execution evidence: ...'", () => {
    // The phrase "No Execution evidence:" must NOT qualify as evidence
    expect(hasExecutionEvidence("No Execution evidence: this PR has no tests")).toBe(false);
  });

  it("returns false for negation in a heading: '## No Execution evidence:'", () => {
    const body = `## Summary\nFoo.\n\n## No Execution evidence:\nThis PR has no test output.\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when heading is present but body after it is empty", () => {
    // Heading exists but there is no content following it (end of string)
    const body = `## Summary\nFoo.\n\n## Execution evidence:`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when heading is present but body after it is only whitespace", () => {
    // Heading exists but subsequent lines are blank before the next section
    const body = `## Summary\nFoo.\n\n## Execution evidence:\n   \n\t\n## Next Section\nContent`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when 'execution evidence:' appears only mid-sentence in prose", () => {
    // The phrase appears embedded in a sentence, not as a heading/label at the start of
    // a line. The implementation requires the marker to appear at line start (after
    // optional # heading chars), so mid-sentence use is correctly rejected.
    // This is the desired behavior — mid-sentence text should not qualify as evidence.
    const body = `## Summary\nThis PR lacks execution evidence: no test run was done.`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when negation uses template placeholder pattern", () => {
    // Template placeholder: "No Execution evidence: N/A" — common in PR templates
    const body = `## Summary\nFoo.\n\nNo Execution evidence: N/A\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  // --- HTML comment stripping (SUBSTANTIVE #2 from PR #909 round 5) ---

  it("returns false when marker is inside an HTML comment", () => {
    // A commented-out marker is invisible in rendered Markdown and must not match
    const body = `## Summary\nFoo.\n\n<!-- Execution evidence: bun test passed -->`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when marker is inside a multi-line HTML comment", () => {
    const body = `## Summary\nFoo.\n\n<!--\n## Execution evidence:\nbun test passed\n-->`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns true when real marker exists outside HTML comment", () => {
    // Comment does NOT contain the marker; the real marker is outside
    const body = `## Summary\nFoo.\n\n<!-- some comment here -->\n\n## Execution evidence:\nbun test passed\n`;
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  it("returns true when real marker exists alongside a commented-out one", () => {
    // Both commented and real markers present — the real one should match
    const body = `<!-- Execution evidence: fake -->\n## Execution evidence:\nbun test passed\n`;
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  // --- Heading-form marker acceptance, no colon required (mt#2648) ---

  it("detects '## Execution evidence' heading with NO colon (mt#2648)", () => {
    // Originating incident: PR #1798 (mt#2613) was blocked despite a complete
    // markdown-heading evidence section because it had no trailing colon.
    const body = `## Summary\nFoo.\n\n## Execution evidence\nbun test passed: 3 pass, 0 fail\n`;
    expect(hasExecutionEvidence(body)).toBe(true);
  });

  it("detects heading form at any heading level (h1-h6), colon optional", () => {
    expect(hasExecutionEvidence("# Execution evidence\nbun test passed")).toBe(true);
    expect(hasExecutionEvidence("### Execution evidence\nbun test passed")).toBe(true);
    expect(hasExecutionEvidence("###### Execution evidence\nbun test passed")).toBe(true);
  });

  it("detects heading form case-insensitively with no colon", () => {
    expect(hasExecutionEvidence("## execution evidence\nall passed")).toBe(true);
    expect(hasExecutionEvidence("## EXECUTION EVIDENCE\nall passed")).toBe(true);
  });

  it("detects heading form with inline content on the same line, no colon", () => {
    expect(hasExecutionEvidence("## Execution evidence bun test passed, 3/3")).toBe(true);
  });

  it("treats an INDENTED next heading as a section boundary (empty section still blocks)", () => {
    // R2: the end-boundary scan must mirror the start-marker's 3-space
    // indent tolerance — an empty evidence section followed by an indented
    // next heading must NOT count that heading line as content.
    const body = `## Execution evidence\n   ## Next Section\nprose\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("detects heading form indented up to 3 spaces (CommonMark), but not 4+", () => {
    expect(hasExecutionEvidence(" ## Execution evidence\nbun test passed")).toBe(true);
    expect(hasExecutionEvidence("   ## Execution evidence\nbun test passed")).toBe(true);
    // 4+ spaces is a CommonMark code block, not a heading
    expect(hasExecutionEvidence("    ## Execution evidence\nbun test passed")).toBe(false);
  });

  it("still requires a colon for the non-heading plain-label form (unchanged)", () => {
    // "Execution evidence" with no heading marker and no colon must NOT match —
    // this preserves the true-negative behavior for bare prose.
    const body = `## Summary\nFoo.\n\nExecution evidence\nbun test passed\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false for negation in heading-form-without-colon: '## No Execution evidence'", () => {
    const body = `## Summary\nFoo.\n\n## No Execution evidence\nThis PR has no test output.\n`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when heading form (no colon) has no following content", () => {
    const body = `## Summary\nFoo.\n\n## Execution evidence\n\n## Next Section\nContent`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });

  it("returns false when heading-form-without-colon marker is inside an HTML comment", () => {
    const body = `## Summary\nFoo.\n\n<!-- ## Execution evidence\nbun test passed -->`;
    expect(hasExecutionEvidence(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasBypassPrefix
// ---------------------------------------------------------------------------

describe("hasBypassPrefix", () => {
  it("detects marker at start of title", () => {
    expect(hasBypassPrefix(TITLE_BYPASS)).toBe(true);
  });

  it("detects marker in the middle — after conventional-commit prefix", () => {
    // prepare-pr composes: "feat(mt#1459): [unverified-tests] real title"
    // The visible PR title puts the marker mid-string; hasBypassPrefix must find it.
    expect(hasBypassPrefix("feat(mt#1459): [unverified-tests] real title")).toBe(true);
  });

  it("detects marker at the end of the title", () => {
    expect(hasBypassPrefix("Add new tests [unverified-tests]")).toBe(true);
  });

  it("detects uppercase variant", () => {
    expect(hasBypassPrefix("[UNVERIFIED-TESTS] Add new session tests")).toBe(true);
  });

  it("detects mixed case", () => {
    expect(hasBypassPrefix("[Unverified-Tests] My PR title")).toBe(true);
  });

  it("returns false when marker is absent", () => {
    expect(hasBypassPrefix("Add new session tests")).toBe(false);
  });

  it("returns false when the word unverified-tests appears without brackets", () => {
    // Must be bracket-delimited to qualify — bare word does not bypass
    expect(hasBypassPrefix("unverified-tests Add new tests")).toBe(false);
  });

  it("handles leading whitespace in title", () => {
    expect(hasBypassPrefix("  [unverified-tests] My PR")).toBe(true);
  });

  it("returns false for empty title", () => {
    expect(hasBypassPrefix("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkExecutionEvidence — silent on no-test-file PRs
// ---------------------------------------------------------------------------

describe("checkExecutionEvidence — no test files added", () => {
  it("allows PR with only source code changes (no hook fires)", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_FOO_TS, status: "added" },
      { filename: "src/adapters/cli/bar.ts", status: "modified" },
    ];
    const result = checkExecutionEvidence(files, TITLE_PLAIN, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toHaveLength(0);
    expect(result.bypassDetected).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("allows PR with only modified test files (modifications-only)", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_FOO_TEST_TS, status: "modified" },
      { filename: FIXTURE_FOO_TS, status: "modified" },
    ];
    const result = checkExecutionEvidence(files, "Update tests", "## Summary\nUpdated.");
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toHaveLength(0);
  });

  it("allows empty PR files list", () => {
    const result = checkExecutionEvidence([], "Empty PR", "");
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkExecutionEvidence — blocks when evidence is missing
// ---------------------------------------------------------------------------

describe("checkExecutionEvidence — blocks on missing evidence", () => {
  const newTestFile: PrFile = { filename: FIXTURE_FOO_TEST_TS, status: "added" };

  it("blocks PR adding test file without execution evidence", () => {
    const result = checkExecutionEvidence([newTestFile], TITLE_PLAIN, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.newTestFiles).toEqual([FIXTURE_FOO_TEST_TS]);
    expect(result.bypassDetected).toBe(false);
  });

  it("error message references the new test file", () => {
    const result = checkExecutionEvidence([newTestFile], "Add tests", BODY_NO_EVIDENCE);
    expect(result.reason).toContain(FIXTURE_FOO_TEST_TS);
  });

  it("error message contains remediation instructions", () => {
    const result = checkExecutionEvidence([newTestFile], "Add tests", BODY_NO_EVIDENCE);
    const reason = result.reason ?? "";
    expect(reason).toContain("Execution evidence:");
    expect(reason).toContain("[unverified-tests]");
    expect(reason).toContain("mcp__minsky__session_pr_edit");
  });

  it("error message names the accepted marker forms (mt#2648)", () => {
    const result = checkExecutionEvidence([newTestFile], "Add tests", BODY_NO_EVIDENCE);
    const reason = result.reason ?? "";
    expect(reason).toContain("Accepted marker forms");
    expect(reason).toContain("## Execution evidence");
  });

  it("enumerates all new test files in error message", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_A_TEST_TS, status: "added" },
      { filename: FIXTURE_B_SPEC_TS, status: "added" },
      { filename: FIXTURE_INTEGRATION_TEST_TS, status: "added" },
    ];
    const result = checkExecutionEvidence(files, "Add tests", BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(true);
    expect(result.newTestFiles).toHaveLength(3);
    const reason = result.reason ?? "";
    expect(reason).toContain(FIXTURE_A_TEST_TS);
    expect(reason).toContain(FIXTURE_B_SPEC_TS);
    expect(reason).toContain(FIXTURE_INTEGRATION_TEST_TS);
  });
});

// ---------------------------------------------------------------------------
// checkExecutionEvidence — allows with evidence block present
// ---------------------------------------------------------------------------

describe("checkExecutionEvidence — allows when evidence block present", () => {
  it("allows PR with execution evidence in body", () => {
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(files, TITLE_PLAIN, BODY_WITH_EVIDENCE);
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toEqual([FIXTURE_FOO_TEST_TS]);
    expect(result.bypassDetected).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("allows PR with lowercase 'execution evidence:' heading", () => {
    const files: PrFile[] = [{ filename: "tests/e2e/flow.spec.ts", status: "added" }];
    const body = "## Summary\n\nexecution evidence: bun test ... all passed";
    const result = checkExecutionEvidence(files, "Add e2e spec", body);
    expect(result.blocked).toBe(false);
  });

  it("allows PR with multiple new test files and evidence block", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_A_TEST_TS, status: "added" },
      { filename: FIXTURE_B_SPEC_TS, status: "added" },
    ];
    const body = `## Summary\nAdded tests.\n\n## Execution evidence:\nbun test passed: 2 tests, 0 failures.\n`;
    const result = checkExecutionEvidence(files, "Add tests", body);
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toHaveLength(2);
  });

  it("allows PR with heading-form evidence section with no colon (mt#2648)", () => {
    // Reproduces the PR #1798 (mt#2613) incident shape: a complete markdown
    // ## Execution evidence section with no trailing colon.
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const body = `## Summary\nAdded tests.\n\n## Execution evidence\nbun test passed: 5 pass, 0 fail.\n`;
    const result = checkExecutionEvidence(files, TITLE_PLAIN, body);
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkExecutionEvidence — bypass prefix allows without evidence
// ---------------------------------------------------------------------------

describe("checkExecutionEvidence — [unverified-tests] bypass prefix", () => {
  it("allows merge when title has [unverified-tests] prefix (no evidence in body)", () => {
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(files, TITLE_BYPASS, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(false);
    expect(result.bypassDetected).toBe(true);
    expect(result.newTestFiles).toEqual([FIXTURE_FOO_TEST_TS]);
  });

  it("includes a warning when bypass is used", () => {
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(files, TITLE_BYPASS, "## Summary");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bypass");
  });

  it("allows with uppercase [UNVERIFIED-TESTS] prefix", () => {
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(
      files,
      "[UNVERIFIED-TESTS] Add new tests",
      BODY_NO_EVIDENCE
    );
    expect(result.blocked).toBe(false);
    expect(result.bypassDetected).toBe(true);
  });

  it("bypasses when [unverified-tests] is mid-title (after conventional-commit prefix)", () => {
    // prepare-pr composes: "feat(mt#X): [unverified-tests] real title"
    // The marker is not at position 0 of the visible title, but must still fire.
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(
      files,
      "feat(mt#1459): [unverified-tests] Add new tests",
      BODY_NO_EVIDENCE
    );
    expect(result.blocked).toBe(false);
    expect(result.bypassDetected).toBe(true);
  });

  it("does NOT bypass when unverified-tests appears without brackets", () => {
    // Bracket delimiters are required — bare word must not bypass
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(
      files,
      "unverified-tests Add new tests",
      BODY_NO_EVIDENCE
    );
    expect(result.blocked).toBe(true);
    expect(result.bypassDetected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-file enumeration in error message
// ---------------------------------------------------------------------------

describe("checkExecutionEvidence — integration scenarios", () => {
  it("block message references all new test files (acceptance test 4)", () => {
    // Acceptance test 4: multiple new test files, evidence block must enumerate them
    // (or body must explicitly enumerate — we check that all files appear in block message)
    const files: PrFile[] = [
      { filename: FIXTURE_SESSION_INTEGRATION_TEST_TS, status: "added" },
      { filename: FIXTURE_TASKS_INTEGRATION_TEST_TS, status: "added" },
      { filename: FIXTURE_SESSION_TEST_TS, status: "added" },
    ];
    const result = checkExecutionEvidence(files, TITLE_ADD_INTEGRATION, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(true);
    const reason = result.reason ?? "";
    expect(reason).toContain(FIXTURE_SESSION_INTEGRATION_TEST_TS);
    expect(reason).toContain(FIXTURE_TASKS_INTEGRATION_TEST_TS);
    expect(reason).toContain(FIXTURE_SESSION_TEST_TS);
    // Sanity: count = 3
    expect(result.newTestFiles).toHaveLength(3);
  });

  it("allows PR adding only non-test files (acceptance test 3)", () => {
    // Acceptance test 3: session_pr_merge on a PR modifying only src/foo.ts → hook silent
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TS, status: "modified" }];
    const result = checkExecutionEvidence(files, "Fix bug in foo", "## Summary\nFixed a bug.");
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("allows PR adding integration test with evidence (acceptance test 2)", () => {
    // Acceptance test 2: same PR, but body updated with execution evidence block
    const files: PrFile[] = [{ filename: FIXTURE_INTEGRATION_TEST_TS, status: "added" }];
    const body = `## Summary\nAdded integration test.\n\n## Execution evidence:\nbun test passed: 1 pass, 0 fail\n`;
    const result = checkExecutionEvidence(files, TITLE_ADD_INTEGRATION, body);
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toEqual([FIXTURE_INTEGRATION_TEST_TS]);
  });

  it("blocks PR adding integration test without evidence (acceptance test 1)", () => {
    // Acceptance test 1: session_pr_merge on a PR adding tests/integration/foo.integration.test.ts
    // with no execution evidence in the body → hook blocks with a clear error
    const files: PrFile[] = [{ filename: FIXTURE_INTEGRATION_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(
      files,
      TITLE_ADD_INTEGRATION,
      "## Summary\nAdded integration test."
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain(FIXTURE_INTEGRATION_TEST_TS);
  });
});

// ---------------------------------------------------------------------------
// parseGitHubRemoteUrl — repo derivation (BLOCKING #2)
// ---------------------------------------------------------------------------

describe("parseGitHubRemoteUrl", () => {
  it("parses SCP-style SSH URL", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky.git")).toBe("edobry/minsky");
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses HTTPS URL with .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses HTTPS URL without .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses HTTPS URL with embedded token", () => {
    expect(parseGitHubRemoteUrl("https://token123@github.com/edobry/minsky.git")).toBe(
      "edobry/minsky"
    );
  });

  it("parses URL-style SSH with git+ssh prefix", () => {
    expect(parseGitHubRemoteUrl("git+ssh://git@github.com/edobry/minsky.git")).toBe(
      "edobry/minsky"
    );
  });

  it("parses URL-style SSH without prefix", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("returns null for non-GitHub remote", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/edobry/minsky.git")).toBeNull();
    expect(parseGitHubRemoteUrl("git@bitbucket.org:edobry/minsky.git")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubRemoteUrl("")).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(parseGitHubRemoteUrl("not-a-url")).toBeNull();
  });

  it("handles trailing newline in URL (common from git remote get-url)", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky.git\n")).toBe("edobry/minsky");
  });
});

// ---------------------------------------------------------------------------
// resolvePrNumber — BLOCKING #2 from PR #909 round 2 review
// ---------------------------------------------------------------------------

/** Helper: builds an ExecFn that returns canned responses based on command prefix */
function makeExecFn(responses: Array<{ match: string; exitCode: number; stdout: string }>): ExecFn {
  return (cmd: string[]) => {
    const joined = cmd.join(" ");
    for (const r of responses) {
      if (joined.includes(r.match)) {
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: "" };
      }
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  };
}

describe("resolvePrNumber", () => {
  const REPO = "edobry/minsky";
  const TASK = "mt#1459";
  const CWD = "/tmp";

  it("resolves PR via gh pr view (primary path)", () => {
    const exec = makeExecFn([{ match: "pr view", exitCode: 0, stdout: "909" }]);
    const { prNumber, warning } = resolvePrNumber(REPO, TASK, CWD, exec);
    expect(prNumber).toBe(909);
    expect(warning).toBeUndefined();
  });

  it("falls back to gh pr list when gh pr view fails", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 1, stdout: "" },
      { match: "pr list", exitCode: 0, stdout: "909" },
    ]);
    const { prNumber, warning } = resolvePrNumber(REPO, TASK, CWD, exec);
    expect(prNumber).toBe(909);
    expect(warning).toBeUndefined();
  });

  it("falls back to gh pr list when gh pr view returns non-numeric output", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: "null" },
      { match: "pr list", exitCode: 0, stdout: "123" },
    ]);
    const { prNumber, warning } = resolvePrNumber(REPO, TASK, CWD, exec);
    expect(prNumber).toBe(123);
    expect(warning).toBeUndefined();
  });

  it("returns null and emits warning when both paths fail", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 1, stdout: "" },
      { match: "pr list", exitCode: 1, stdout: "" },
    ]);
    const { prNumber, warning } = resolvePrNumber(REPO, TASK, CWD, exec);
    expect(prNumber).toBeNull();
    expect(warning).toBeDefined();
    expect(warning).toContain("Could not resolve PR number");
    expect(warning).toContain("gh pr view");
    expect(warning).toContain("gh pr list");
  });

  it("returns null and emits warning when both paths return zero/empty", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: "0" },
      { match: "pr list", exitCode: 0, stdout: "" },
    ]);
    const { prNumber, warning } = resolvePrNumber(REPO, TASK, CWD, exec);
    expect(prNumber).toBeNull();
    expect(warning).toBeDefined();
  });

  it("uses task-derived branch in fallback path", () => {
    const seenCmds: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmds.push(cmd.join(" "));
      if (cmd.join(" ").includes("pr view")) return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd.join(" ").includes("pr list")) return { exitCode: 0, stdout: "42", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    resolvePrNumber(REPO, TASK, CWD, exec);
    const listCmd = seenCmds.find((c) => c.includes("pr list"));
    expect(listCmd).toBeDefined();
    expect(listCmd).toContain("task/mt-1459");
  });
});

// ---------------------------------------------------------------------------
// fetchPrFiles warning propagation — BLOCKING #3 from PR #909 round 2 review
// ---------------------------------------------------------------------------

describe("makeProdPrDeps.fetchPrFiles — warning propagation", () => {
  // We test the shape of FetchPrFilesResult by constructing it directly.
  // The actual gh API calls are integration-level; here we verify the contract.

  it("FetchPrFilesResult with no warning has only files", () => {
    const result: FetchPrFilesResult = { files: [{ filename: "src/foo.ts", status: "added" }] };
    expect(result.files).toHaveLength(1);
    expect(result.warning).toBeUndefined();
  });

  it("FetchPrFilesResult with warning has empty files and a warning string", () => {
    const result: FetchPrFilesResult = {
      files: [],
      warning: "fetchPrFiles: gh api failed (exit 1) for PR #1 — test-file detection skipped.",
    };
    expect(result.files).toHaveLength(0);
    expect(result.warning).toContain("test-file detection skipped");
  });

  it("checkExecutionEvidence with empty files (simulating fetchPrFiles failure) allows merge", () => {
    // When fetchPrFiles returns [] due to API failure, the check should allow merge
    // (fail-open). The warning is surfaced separately by the top-level entry point.
    const result = checkExecutionEvidence([], "Add tests", "## Summary\nNo evidence.");
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Operational-script coverage (mt#2776)
// ---------------------------------------------------------------------------

const FIXTURE_SCRIPT = "scripts/backfill-foo.ts";

describe("isOperationalScript", () => {
  it("matches top-level scripts/<name>.ts", () => {
    expect(isOperationalScript(FIXTURE_SCRIPT)).toBe(true);
    expect(isOperationalScript("scripts/migrate.ts")).toBe(true);
  });

  it("does not match a test file under scripts/", () => {
    expect(isOperationalScript("scripts/foo.test.ts")).toBe(false);
  });

  it("matches nested scripts at any depth (scripts/**.ts)", () => {
    expect(isOperationalScript("scripts/sub/x.ts")).toBe(true);
    expect(isOperationalScript("scripts/migrations/backfill.ts")).toBe(true);
  });

  it("does not match non-scripts .ts or non-.ts scripts", () => {
    expect(isOperationalScript(FIXTURE_FOO_TS)).toBe(false);
    expect(isOperationalScript("scripts/foo.js")).toBe(false);
  });
});

describe("findNewOperationalScripts", () => {
  it("returns added operational scripts, ignoring modified/removed and non-scripts", () => {
    const files: PrFile[] = [
      { filename: FIXTURE_SCRIPT, status: "added" },
      { filename: "scripts/existing.ts", status: "modified" },
      { filename: "scripts/gone.ts", status: "removed" },
      { filename: FIXTURE_FOO_TS, status: "added" },
    ];
    expect(findNewOperationalScripts(files)).toEqual([FIXTURE_SCRIPT]);
  });

  it("includes a rename/copy promotion into scripts/ from a non-script path, excludes script→script renames", () => {
    const files: PrFile[] = [
      {
        filename: "scripts/promoted.ts",
        status: "renamed",
        previous_filename: "tools/promoted.ts",
      },
      {
        filename: "scripts/moved.ts",
        status: "renamed",
        previous_filename: "scripts/moved-old.ts",
      },
    ];
    expect(findNewOperationalScripts(files)).toEqual(["scripts/promoted.ts"]);
  });
});

describe("checkExecutionEvidence — operational scripts (mt#2776)", () => {
  const SCRIPT: PrFile = { filename: FIXTURE_SCRIPT, status: "added" };

  it("blocks a new operational script with no execution evidence", () => {
    const result = checkExecutionEvidence([SCRIPT], TITLE_PLAIN, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(true);
    expect(result.newScripts).toEqual([FIXTURE_SCRIPT]);
    expect(result.reason).toContain("operational script");
  });

  it("allows a new operational script when execution evidence is present", () => {
    const result = checkExecutionEvidence([SCRIPT], TITLE_PLAIN, BODY_WITH_EVIDENCE);
    expect(result.blocked).toBe(false);
    expect(result.newScripts).toEqual([FIXTURE_SCRIPT]);
  });

  it("allows a new operational script with the [unverified-tests] bypass", () => {
    const result = checkExecutionEvidence([SCRIPT], TITLE_BYPASS, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(false);
    expect(result.bypassDetected).toBe(true);
  });

  it("is silent when a script is only modified (not added)", () => {
    const result = checkExecutionEvidence(
      [{ filename: "scripts/existing.ts", status: "modified" }],
      TITLE_PLAIN,
      BODY_NO_EVIDENCE
    );
    expect(result.blocked).toBe(false);
    expect(result.newScripts).toHaveLength(0);
  });

  it("blocks on a combined new test + new script diff and names both classes", () => {
    const result = checkExecutionEvidence(
      [SCRIPT, { filename: FIXTURE_FOO_TEST_TS, status: "added" }],
      TITLE_PLAIN,
      BODY_NO_EVIDENCE
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("test file");
    expect(result.reason).toContain("operational script");
  });
});

// ---------------------------------------------------------------------------
// mt#3033: Acceptance-test cross-reference (CALIBRATION-FIRST, log-only)
// ---------------------------------------------------------------------------

/** AT3 text fixture (mt#2542's literal, unaddressed acceptance test) — hoisted once. */
const AT3_TEXT = "All deployed services boot and operate on the DML-only role.";
/** Distinctive keyword fragment shared by every AT3-related assertion below. */
const AT3_KEYWORD_FRAGMENT = "services boot and operate";
/** Shared section heading, reused across bullet-list fixtures (mt#3078) to satisfy `custom/no-magic-string-duplication`. */
const AT_SECTION_HEADING = "## Acceptance Tests\n\n";

/** mt#2542 incident-shaped fixture: 3 ATs, AT3 is the literal, unaddressed test. */
const SPEC_MT2542_3_AT = `## Summary
Adds a DML-only Postgres role.

## Acceptance Tests

1. CREATE TABLE is denied for the DML-only role.
2. All 37 tables are granted DML privileges to the role.
3. ${AT3_TEXT}
`;

/** Proxy-only evidence — covers AT1/AT2 but never exercises AT3 (the mt#2542 gap). */
const PROXY_EVIDENCE_BODY = `## Summary
Adds a DML-only Postgres role.

## Execution evidence:
CREATE TABLE denied: confirmed.
37/37 tables granted DML privileges.
`;

const SPEC_FINDINGS_ONLY = `## Acceptance Tests

1. Audit produces a list of affected records.
2. Decision recorded in the task spec.
`;

const SPEC_NO_AT_SECTION = `## Summary
Docs-only change.

## Testing
N/A.
`;

/**
 * mt#3306 Defect 1 fixture — trimmed from the REAL mt#3117 spec (PR #2234), preserving
 * the exact heading shapes/nesting that produced the false positive: 4 numbered ATs
 * immediately followed by a `### Covers` / `### Does NOT cover` pair (the
 * `work-completion.mdc §Recovery layer spec discipline` convention), then a `## Context`
 * sibling. Pre-fix, `extractAcceptanceTestsSection`'s `\n##\s` lookahead never fired on
 * `### Covers` (its third `#` fails the `\s` check), so extraction ran past both
 * subsections and the live check reported "2 of 10 executable acceptance tests" against
 * a spec that declares exactly 4.
 */
const SPEC_MT3117_AT = `## Summary
Reviewer deploy-keyed migration, replacing Railway's native auto-trigger.

## Acceptance Tests

1. **Sole-path test.** A push to \`main\` touching only \`services/reviewer/**\` results in exactly one deploy, driven by the new workflow; Railway's native trigger produces no independent deployment.
2. **Migrate-gates-traffic test.** With a deliberately failing reviewer migration on a test branch, the workflow fails at the migrate step, no new image is promoted, and the previously-deployed reviewer continues serving \`/health\` 200.
3. **Real migration-bearing deploy.** A commit adding a real (no-op-safe) reviewer migration deploys through the workflow: migrate applies as \`postgres\`, image is promoted, \`/health\` returns 200, and the new row is present in \`drizzle.__drizzle_migrations_reviewer\`.
4. **Credential-boundary test.** The reviewer's Railway service environment contains no DDL-capable Postgres credential attributable to this workflow; the migrate step's credential resolves only from the CI secret.

### Covers

- Reviewer migration never applied before dependent reviewer code takes traffic (the ordering hazard above).
- Boot-time migrate failures taking the service down during a DB outage (once mt#3030 removes boot migrate).
- Unsynchronized branch-wide reviewer redeploys on unrelated pushes.

### Does NOT cover

- Main-domain migration ordering vs reviewer migration when a single change spans BOTH trees — no cross-tree ordering primitive is introduced here. **No current owner — file if such a change is attempted.**
- Schema drift introduced out-of-band (manual SQL against prod) — \`verifyExpectedTables\` catches missing expected tables only.
- Pre-merge detection of Dockerfile/runtime contract breaks — mt#1557.

## Context

Parent: mt#3059.
`;

/**
 * mt#3306 Defect 2 fixture — trimmed from the REAL mt#3142 spec (PR #2365), preserving
 * the exact document order that produced the false positive: a `### Remaining acceptance
 * tests` section (3 items) appended near the TOP under a "current scope, read this
 * first" rescoping preface, with the ORIGINAL `## Acceptance Tests` section (5 items,
 * dispositioned DONE) kept further down as an audit trail. Pre-fix,
 * `.match()`'s first-match semantics meant extraction always read the stale 5-item
 * section, and the live check reported "3 of 5 executable acceptance tests not
 * addressed" naming AT2/AT3/AT4 — all three satisfied days earlier.
 */
const SPEC_MT3142_AT = `## Current scope (rescoped 2026-07-24 during \`/plan-task\`) — READ THIS FIRST

**The production outage this task was filed for is RESOLVED.**

**Success-criteria disposition:**

- SC#2, SC#3, SC#4 (reviewer serves; \`/retrigger\` reached; a live PR gets reviewed) — **DONE**,
  verified at the 17:28Z recovery.

### Remaining success criteria (supersede the original SC list above, which is fully dispositioned)

- [ ] \`docs/deploy-minsky-railway.md\` states that a Railway service can hold \`source.image\` AND a
      standing native GitHub **deployment trigger** at the same time.

### Remaining acceptance tests

- \`grep -c 'deploymentTrigger' docs/deploy-minsky-railway.md\` returns non-zero, and the surrounding
  text states the trigger survives \`sourceRepo: null\`.
- \`grep -c 'railway open --print' docs/deploy-minsky-railway.md\` returns non-zero.
- A reader following only that doc can answer "why did a service with \`sourceImage\` set still deploy
  from the repo?" without consulting this task's incident narrative.

## Summary

The Railway service behind \`minsky-reviewer-webhook-production.up.railway.app\` was serving the
Minsky MCP server, not the reviewer webhook service.

## Success Criteria

- [ ] Root cause identified and named.
- [ ] The reviewer-webhook service serves the reviewer application again.

## Scope

**In scope:** identifying and fixing the entrypoint/config defect.

## Acceptance Tests

- \`deployment_logs(service: "reviewer", type: "deploy")\` on the current deployment shows the
  reviewer's startup banner and no \`Minsky MCP Server\` line.
- \`curl -X POST .../retrigger\` with no auth header returns 401 (route reached), not 404.
- \`reviewer_retrigger(pr: <open PR>)\` returns \`ok: true\`.
- An open PR receives a bot review within the normal window, observed live.
- Deliberately mis-pointing the service entrypoint in a test/preview environment causes the new
  deploy check to FAIL — proving the check discriminates, rather than passing on any 200.

## Context

Found 2026-07-23 while driving a PR to convergence.
`;

/**
 * mt#3059 FP-3 fixture (mt#3316 fix) — trimmed from the REAL mt#3174 spec (PR #2264). AT2's
 * text is quoted verbatim from mt#3059's `## Observed false positives` FP-3 entry.
 */
const SPEC_MT3174_AT = `## Summary
Cockpit entity-reference layer: label channel, hover primitive, EntityRef.

## Acceptance Tests

1. Stub the label channel to fail; render \`<Prose>\` with a known \`mt#NNNN\`: renders, links, bare id, no badge shell/spinner/layout shift.
2. Render a surface with K>1 references and count label requests: one, not K.
3. \`entity-linkifier.test.ts\` unmodified: passes (62/62).
4. Single-line string through the inline-only path: linkified, no block wrapper.
5. \`<EntityRef>\` per entity type (task shows title+status; five payload-backed types show label; unknown id degrades to plain linked id).
6. Hover disabled: title still readable inline.
`;

/**
 * mt#3059 FP-3 fixture (mt#3316 fix) — trimmed from the REAL PR #2264 body (see
 * mcp__minsky__changeset_get id "2264" for the untrimmed original). The literal
 * `## Execution evidence:` block ends at the `### Acceptance tests (mt#3174 spec, by
 * number)` heading; AT2's reference lives entirely in that SIBLING section, outside the
 * pre-fix `extractExecutionEvidenceText` scan boundary (which stopped at the next heading
 * of any level). Pre-fix, the AT-coverage check reported AT2 as unaddressed against real,
 * already-satisfied evidence — the false positive recorded as FP-3 in mt#3059's running FP
 * log (fired live 2026-07-24 against this exact PR).
 */
const PR_BODY_MT3174_FP3 = `## Summary
Entity-reference layer.

## Execution evidence:

Server-side (no DOM):
\`\`\`
bun test --preload ./tests/setup.ts --timeout=15000 src/cockpit/task-title-cache.test.ts

14 pass
0 fail
\`\`\`

### Acceptance tests (mt#3174 spec, by number)

1. Stub the label channel to fail; render \`<Prose>\` with a known \`mt#NNNN\`:
   renders, links, bare id, no badge shell/spinner/layout shift —
   \`Prose.test.tsx\` "acceptance test: label channel stubbed to fail...".
2. K>1 references → one label request, not K —
   \`use-entity-index.test.tsx\` "K simultaneously-mounted... issue ONE
   /api/tasks/meta request, not K".
3. \`entity-linkifier.test.ts\` unmodified: passes (62/62, included above).
4. Single-line string through the inline-only path: linkified, no block
   wrapper — \`entity-linkifier.mt3174.test.tsx\` "Inline-only linkify path".
5. \`<EntityRef>\` per entity type (task shows title+status; five
   payload-backed types show label; unknown id degrades to plain linked id)
   — \`EntityRef.test.tsx\` "per-type label resolution".
6. Hover disabled: title still readable inline — \`EntityRef.test.tsx\`
   "hover is supplementary, not load-bearing".

## Out of scope (per mt#3174/mt#3165)

Adoption at any render surface (mt#3175).
`;

describe("extractAcceptanceTestsSection", () => {
  it("extracts content between the heading and the next heading", () => {
    const section = extractAcceptanceTestsSection(SPEC_MT2542_3_AT);
    expect(section).not.toBeNull();
    expect(section).toContain("CREATE TABLE is denied");
    expect(section).toContain(AT3_KEYWORD_FRAGMENT);
  });

  it("returns null when no Acceptance Tests section exists", () => {
    expect(extractAcceptanceTestsSection(SPEC_NO_AT_SECTION)).toBeNull();
  });

  it("stops at the next ## heading", () => {
    const spec = `## Acceptance Tests\n\n1. First test.\n\n## Context\n\nUnrelated.`;
    const section = extractAcceptanceTestsSection(spec) ?? "";
    expect(section).toContain("First test");
    expect(section).not.toContain("Unrelated");
  });

  it("stops at a --- divider", () => {
    const spec = `## Acceptance Tests\n\n1. First test.\n\n---\n\nFooter.`;
    const section = extractAcceptanceTestsSection(spec) ?? "";
    expect(section).toContain("First test");
    expect(section).not.toContain("Footer");
  });

  // mt#3306 Defect 1 regression: a following `### <heading>` (nested, three hashes) must
  // terminate the section just like a `##` sibling does. Pre-fix the old `\n##\s`
  // lookahead never fired on a three-hash heading, so extraction ran past it.
  it("stops at a following ### heading, not just an exact ## sibling", () => {
    const spec = `## Acceptance Tests\n\n1. First test.\n\n### Covers\n\n- Not an AT.\n`;
    const section = extractAcceptanceTestsSection(spec) ?? "";
    expect(section).toContain("First test");
    expect(section).not.toContain("Not an AT");
  });

  // mt#3306 Defect 1, real-spec fixture (mt#3117 / PR #2234): the section body must not
  // include either of the sibling `### Covers` / `### Does NOT cover` subsections.
  it("stops before ### Covers / ### Does NOT cover for the real mt#3117 fixture", () => {
    const section = extractAcceptanceTestsSection(SPEC_MT3117_AT) ?? "";
    expect(section).toContain("Credential-boundary test");
    expect(section).not.toContain("### Covers");
    expect(section).not.toContain("### Does NOT cover");
    expect(section).not.toContain("Schema drift introduced out-of-band");
  });

  // mt#3306 Defect 2, real-spec fixture (mt#3142 / PR #2365): a superseding
  // `### Remaining acceptance tests` section — appended EARLIER in the document than the
  // stale original `## Acceptance Tests` section it replaces — must win.
  it("returns the superseding section for the real mt#3142 fixture, not the earlier-matched original", () => {
    const section = extractAcceptanceTestsSection(SPEC_MT3142_AT) ?? "";
    expect(section).toContain("grep -c 'deploymentTrigger'");
    expect(section).toContain("railway open --print");
    // The stale original section's content (further down in the document) must be absent.
    expect(section).not.toContain("Minsky MCP Server` line");
    expect(section).not.toContain("mis-pointing the service entrypoint");
  });

  // mt#3306 regression pin: an ordinary spec with a single, plain `## Acceptance Tests`
  // section and no nested subsections or superseding heading must parse byte-identically
  // to the pre-fix behavior. Guards against the fix silently changing the common case.
  it("regression: a plain single Acceptance Tests section with no nesting is unaffected", () => {
    const section = extractAcceptanceTestsSection(SPEC_MT2542_3_AT);
    expect(section).toBe(
      "1. CREATE TABLE is denied for the DML-only role.\n2. All 37 tables are granted DML privileges to the role.\n3. All deployed services boot and operate on the DML-only role.\n"
    );
  });
});

describe("parseAcceptanceTests", () => {
  it("parses a numbered list into items", () => {
    const items = parseAcceptanceTests(SPEC_MT2542_3_AT);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ number: 1, text: "CREATE TABLE is denied for the DML-only role." });
    expect(items[2]?.number).toBe(3);
    expect(items[2]?.text).toContain(AT3_KEYWORD_FRAGMENT);
  });

  it("joins multi-line continuation onto the preceding item", () => {
    const spec = `## Acceptance Tests\n\n1. First line of item one\n   continues here.\n2. Second item.\n`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("First line of item one continues here.");
    expect(items[1]?.text).toBe("Second item.");
  });

  it("returns an empty array when there is no Acceptance Tests section", () => {
    expect(parseAcceptanceTests(SPEC_NO_AT_SECTION)).toHaveLength(0);
  });

  it("returns an empty array when the section has no numbered items", () => {
    const spec = `## Acceptance Tests\n\nSee above.\n`;
    expect(parseAcceptanceTests(spec)).toHaveLength(0);
  });

  // mt#3078: bullet-list support. The canonical `/create-task` skill template
  // (`.claude/skills/create-task/SKILL.md`) writes `## Acceptance Tests` as a
  // bullet list, never a numbered one — pre-fix, every task spec authored via
  // that standard workflow parsed to `[]` here, silently making the AT-coverage
  // check inapplicable for the common case.
  it("parses a bullet list ('- ') into sequentially-numbered items", () => {
    const spec = `${AT_SECTION_HEADING}- The widget renders a blue button on the settings page.
- Clicking the button opens the export dialog.
- The cancel button discards the draft without saving.
`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      number: 1,
      text: "The widget renders a blue button on the settings page.",
    });
    expect(items[1]?.number).toBe(2);
    expect(items[2]?.number).toBe(3);
    expect(items[2]?.text).toBe("The cancel button discards the draft without saving.");
  });

  it("parses a '* ' bullet list the same way as '- '", () => {
    const spec = "## Acceptance Tests\n\n* First test.\n* Second test.\n";
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ number: 1, text: "First test." });
    expect(items[1]).toEqual({ number: 2, text: "Second test." });
  });

  it("joins multi-line continuation onto the preceding bullet item", () => {
    const spec =
      "## Acceptance Tests\n\n- First line of item one\n  continues here.\n- Second item.\n";
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("First line of item one continues here.");
    expect(items[1]?.text).toBe("Second item.");
  });

  it("parses this task's OWN spec-shaped bullet Acceptance Tests (mt#3078 regression fixture)", () => {
    // Mirrors mt#3078's real spec verbatim shape (verified via a live
    // `fetchTaskSpecForAtCoverage` call against the actual task during
    // diagnosis) — a direct regression guard against the exact format that
    // motivated this fix.
    const spec = `${AT_SECTION_HEADING}- Synthetic matching input -> a calibration record appears in each log.
- Negative control: non-matching input -> no record (confirms the fire isn't unconditional).
`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(2);
    expect(items[0]?.number).toBe(1);
    expect(items[1]?.number).toBe(2);
  });

  // PR #2207 R1 (non-blocking #1): GitHub-style checklist items and nested
  // bullets under an AT must not be mis-parsed as extra top-level ATs.
  it("strips a GitHub-style checkbox marker ('- [ ] ...') from bullet AT text", () => {
    const spec = `${AT_SECTION_HEADING}- [ ] Unchecked test description.
- [x] Checked test description.
- [X] Checked (capital X) test description.
`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(3);
    expect(items[0]?.text).toBe("Unchecked test description.");
    expect(items[1]?.text).toBe("Checked test description.");
    expect(items[2]?.text).toBe("Checked (capital X) test description.");
  });

  it("folds an indented (nested) bullet into the parent item instead of counting it as a new AT", () => {
    const spec = `${AT_SECTION_HEADING}- Parent AT covers the main behavior.
  - Sub-detail: covers edge case A.
  - Sub-detail: covers edge case B.
- Second top-level AT.
`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe(
      "Parent AT covers the main behavior. - Sub-detail: covers edge case A. - Sub-detail: covers edge case B."
    );
    expect(items[1]?.text).toBe("Second top-level AT.");
  });

  // mt#3306 Defect 1, real-spec fixture (mt#3117 / PR #2234). Pre-fix this returned 10
  // items (4 real ATs + 3 "### Covers" bullets + 3 "### Does NOT cover" bullets), which
  // is exactly the inflated denominator the live check reported ("2 of 10 executable").
  it("returns exactly 4 items for the real mt#3117 fixture, none of them a Does NOT cover bullet", () => {
    const items = parseAcceptanceTests(SPEC_MT3117_AT);
    expect(items).toHaveLength(4);
    expect(items[0]?.text).toContain("Sole-path test");
    expect(items[1]?.text).toContain("Migrate-gates-traffic test");
    expect(items[2]?.text).toContain("Real migration-bearing deploy");
    expect(items[3]?.text).toContain("Credential-boundary test");
    for (const item of items) {
      expect(item.text).not.toContain("cross-tree ordering primitive");
      expect(item.text).not.toContain("Schema drift introduced out-of-band");
      expect(item.text).not.toContain("Pre-merge detection of Dockerfile");
    }
  });

  // mt#3306 Defect 2, real-spec fixture (mt#3142 / PR #2365). Pre-fix this returned the
  // stale, already-dispositioned 5-item original section; the live check reported "3 of
  // 5 executable acceptance tests not addressed", naming AT2/AT3/AT4 — all three
  // satisfied days earlier. Post-fix, only the 3 items under the superseding
  // `### Remaining acceptance tests` heading are returned.
  it("returns exactly the 3 remaining items for the real mt#3142 fixture", () => {
    const items = parseAcceptanceTests(SPEC_MT3142_AT);
    expect(items).toHaveLength(3);
    expect(items[0]?.text).toContain("grep -c 'deploymentTrigger'");
    expect(items[1]?.text).toContain("grep -c 'railway open --print'");
    expect(items[2]?.text).toContain("A reader following only that doc");
    for (const item of items) {
      expect(item.text).not.toContain("Minsky MCP Server` line");
      expect(item.text).not.toContain("mis-pointing the service entrypoint");
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3059 PR #2386: additions beyond mt#3306's own regression suite above.
// mt#3306's SPEC_MT3117_AT / SPEC_MT3142_AT fixtures and their
// extractAcceptanceTestsSection/parseAcceptanceTests-level tests already cover the
// "exactly 4 ATs" / "exactly 3 ATs" real-spec regressions — reused here rather than
// duplicated. What follows is coverage mt#3306's suite did not have: (a)
// checkAcceptanceTestCoverage-level assertions on those same two real-spec fixtures,
// and (b) the "next heading immediately follows, zero AT content" boundary edge case
// that PR #2386 R1 review caught in the ORIGINAL split-regex implementation and that
// turned out to affect mt#3306's combined-regex form identically (verified empirically
// against this exact fixture before merging the two implementations) — see
// SUPERSEDING_ACCEPTANCE_TESTS_RE's doc comment for the fix.
// ---------------------------------------------------------------------------

describe("checkAcceptanceTestCoverage — mt#3059 FP-1/FP-2 real-spec fixtures", () => {
  it("FP-1: never flags the Does-NOT-cover bullets as unaddressed executable ATs (mt#3117 fixture)", () => {
    const evidenceReferencingAllFour = `## Execution evidence:\nAT1 verified. AT2 verified. AT3 verified. AT4 verified.\n`;
    const result = checkAcceptanceTestCoverage(
      SPEC_MT3117_AT,
      "implementation",
      evidenceReferencingAllFour
    );
    expect(result.executableAts).toHaveLength(4);
    expect(result.unaddressedAts).toHaveLength(0);
  });

  it("FP-2: evaluates only the 3 superseding ATs, not the original 5 (mt#3142 fixture)", () => {
    const evidenceReferencingAllThree = `## Execution evidence:\nAT1 verified via grep. AT2 verified via grep. AT3 verified by reading the doc.\n`;
    const result = checkAcceptanceTestCoverage(
      SPEC_MT3142_AT,
      "implementation",
      evidenceReferencingAllThree
    );
    expect(result.executableAts).toHaveLength(3);
    expect(result.unaddressedAts).toHaveLength(0);
  });

  it("FP-3 (mt#3316 fix): AT2's reference in a sibling 'Acceptance tests (by number)' section is no longer missed (real mt#3174 / PR #2264 fixture)", () => {
    // Pre-fix, extractExecutionEvidenceText stopped at the "### Acceptance tests (mt#3174
    // spec, by number)" heading (the next heading after the Execution evidence block), so
    // AT2's reference — living entirely in that sibling section — was invisible to the
    // coverage check. It fired live against this exact PR (2026-07-24), recorded as FP-3
    // in mt#3059's running FP log. With the mt#3316 widening, the sibling section's content
    // is scanned too, and AT2 is found via its shared "references" keyword.
    const result = checkAcceptanceTestCoverage(
      SPEC_MT3174_AT,
      "implementation",
      PR_BODY_MT3174_FP3
    );
    expect(result.executableAts).toHaveLength(6);
    expect(result.unaddressedAts).toHaveLength(0);
  });
});

describe("extractAcceptanceTestsSection / parseAcceptanceTests — boundary edge case: heading immediately follows, zero AT content", () => {
  // PR #2386 R1 BLOCKING fix: a boundary construction requiring a literal preceding
  // "\n" before the next heading cannot match when that heading is the very FIRST line
  // of the section body (zero AT content, no blank line separating the opening heading
  // from the sibling subsection) — the "\n" that would satisfy it was already consumed
  // by the OPENING heading's own match. That off-by-one lets extraction fall through to
  // whatever heading appears NEXT in the document, over-capturing everything in
  // between. Confirmed this affects mt#3306's combined-regex form identically before
  // merging; both ACCEPTANCE_TESTS_RE and SUPERSEDING_ACCEPTANCE_TESTS_RE now share the
  // `^`-anchored / `(?![\s\S])`-terminated boundary construction that closes it.
  it("plain-heading path: bounds correctly when the next heading immediately follows with zero AT content", () => {
    const spec = `## Acceptance Tests\n### Covers\n- Something this recovery layer covers.\n\n## Context\nUnrelated.\n`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(0);
  });

  it("superseding-heading path: bounds correctly when the next heading immediately follows with zero AT content", () => {
    const spec = `### Remaining acceptance tests\n## Summary\nUnrelated context immediately after, no blank line.\n\n## Acceptance Tests\n\n1. Original AT, should be ignored (superseded).\n`;
    const items = parseAcceptanceTests(spec);
    expect(items).toHaveLength(0);
  });
});

describe("isFindingsShapedAcceptanceTest", () => {
  it("matches 'audit produces' phrasing", () => {
    expect(isFindingsShapedAcceptanceTest("Audit produces a list of affected records.")).toBe(true);
  });

  it("matches 'decision recorded' phrasing", () => {
    expect(isFindingsShapedAcceptanceTest("Decision recorded in the task spec.")).toBe(true);
  });

  it("matches 'documented in/as' phrasing", () => {
    expect(isFindingsShapedAcceptanceTest("Findings documented in the memory entry.")).toBe(true);
  });

  it("does not match a normal executable AT", () => {
    expect(isFindingsShapedAcceptanceTest(AT3_TEXT)).toBe(false);
  });
});

describe("isExecutableAcceptanceTest", () => {
  it("returns false for a state-ops task regardless of text", () => {
    expect(isExecutableAcceptanceTest("The gate blocks the merge.", "state-ops")).toBe(false);
  });

  it("returns false for findings-shaped text", () => {
    expect(
      isExecutableAcceptanceTest("Decision recorded in the task spec.", "implementation")
    ).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isExecutableAcceptanceTest("   ", "implementation")).toBe(false);
  });

  it("returns true for a normal executable AT under a non-state-ops kind", () => {
    expect(isExecutableAcceptanceTest(AT3_TEXT, "implementation")).toBe(true);
  });

  it("returns true when taskKind is undefined and text is executable", () => {
    expect(
      isExecutableAcceptanceTest("The gate blocks the merge, naming the unaddressed AT.")
    ).toBe(true);
  });
});

describe("extractExecutionEvidenceText", () => {
  it("extracts content following the Execution evidence marker", () => {
    const text = extractExecutionEvidenceText(PROXY_EVIDENCE_BODY);
    expect(text).toContain("CREATE TABLE denied");
    expect(text).toContain("37/37 tables granted");
  });

  it("returns an empty string when no marker is present", () => {
    expect(extractExecutionEvidenceText(BODY_NO_EVIDENCE)).toBe("");
  });

  it("ignores a negated 'No Execution evidence:' marker", () => {
    expect(extractExecutionEvidenceText("No Execution evidence: nothing was run.")).toBe("");
  });

  it("mt#3316 FP-3 fix: also includes content from a sibling 'Acceptance tests (by number)' heading, not just the literal Execution evidence block", () => {
    const text = extractExecutionEvidenceText(PR_BODY_MT3174_FP3);
    expect(text).toContain("14 pass");
    expect(text).toContain("K>1 references");
  });

  it("PR #2410 R1 BLOCKING #1 fix: a heading-lookalike line INSIDE a fenced code block does not truncate Execution-evidence collection early", () => {
    // Pasted test output can legitimately contain a line starting with "###" (e.g. a
    // markdown snippet under test, or a stack-trace line). Pre-fix, the "stop at next
    // heading" check matched that fence-internal line and cut collection off before
    // reaching real evidence further down in the SAME fenced block.
    const body = [
      "## Execution evidence:",
      "",
      "```",
      "bun test output:",
      "### This looks like a heading but is inside a fence",
      "5 pass, 0 fail",
      "```",
      "",
      "## Testing",
      "Unrelated section.",
    ].join("\n");
    const text = extractExecutionEvidenceText(body);
    expect(text).toContain("5 pass, 0 fail");
  });

  it("PR #2410 R1 BLOCKING #1 fix: a fenced 'Acceptance tests' heading lookalike is not treated as a real section boundary by the mt#3316 widening", () => {
    // No "Execution evidence:" heading anywhere in this body, so the ONLY way the fake
    // AT content could appear in the extracted text is if the acceptance-tests widening
    // pass incorrectly treats the fence-internal "### Acceptance tests (by number)" line
    // as a real heading trigger.
    const body = [
      "## Summary",
      "Some PR.",
      "",
      "## Testing",
      "",
      "```",
      "Example markdown template:",
      "### Acceptance tests (by number)",
      "1. Fake AT reference: UNIQUEKEYWORDXYZ",
      "```",
      "",
      "No execution evidence block at all here.",
    ].join("\n");
    const text = extractExecutionEvidenceText(body);
    expect(text).not.toContain("UNIQUEKEYWORDXYZ");
  });
});

describe("isAtReferencedByNumber", () => {
  const at3: AcceptanceTestItem = { number: 3, text: AT3_KEYWORD_FRAGMENT };

  it("matches 'AT3'", () => {
    expect(isAtReferencedByNumber(at3, "Verified AT3 by booting the reviewer service.")).toBe(true);
  });

  it("matches 'AT#3'", () => {
    expect(isAtReferencedByNumber(at3, "See AT#3 for the boot verification.")).toBe(true);
  });

  it("matches 'acceptance test 3'", () => {
    expect(isAtReferencedByNumber(at3, "Acceptance test 3 was exercised live.")).toBe(true);
  });

  it("matches 'at-3'", () => {
    expect(isAtReferencedByNumber(at3, "Covered by at-3 verification.")).toBe(true);
  });

  it("does not match an unrelated AT number", () => {
    expect(isAtReferencedByNumber(at3, "AT1 and AT2 were verified.")).toBe(false);
  });

  it("does not false-positive-match AT30 against AT3", () => {
    expect(isAtReferencedByNumber(at3, "AT30 was exercised.")).toBe(false);
  });
});

describe("isAtReferencedByKeyword", () => {
  const at3: AcceptanceTestItem = { number: 3, text: AT3_TEXT };

  it("matches when the evidence shares a distinctive keyword", () => {
    expect(isAtReferencedByKeyword(at3, "Confirmed all services booted successfully.")).toBe(true);
  });

  it("does not match when there is no keyword overlap", () => {
    expect(isAtReferencedByKeyword(at3, "CREATE TABLE denied: confirmed.")).toBe(false);
  });
});

describe("extractAtDeferralMarker / isAtDeferred", () => {
  it("extracts the deferral target for the given AT number", () => {
    const body = `${PROXY_EVIDENCE_BODY}\n[at3-deferred: mt#9999]`;
    expect(extractAtDeferralMarker(body, 3)).toBe("mt#9999");
    expect(isAtDeferred(body, 3)).toBe(true);
  });

  it("is case-insensitive", () => {
    const body = "[AT3-DEFERRED: mt#9999]";
    expect(isAtDeferred(body, 3)).toBe(true);
  });

  it("returns null/false when no marker exists for this AT number", () => {
    expect(extractAtDeferralMarker(PROXY_EVIDENCE_BODY, 3)).toBeNull();
    expect(isAtDeferred(PROXY_EVIDENCE_BODY, 3)).toBe(false);
  });

  it("does not match a marker for a different AT number", () => {
    const body = "[at1-deferred: mt#1234]";
    expect(isAtDeferred(body, 3)).toBe(false);
  });
});

describe("checkAcceptanceTestCoverage", () => {
  it("reproduces the mt#2542 scenario: AT3 unaddressed by proxy-only evidence", () => {
    const result: AtCoverageResult = checkAcceptanceTestCoverage(
      SPEC_MT2542_3_AT,
      "implementation",
      PROXY_EVIDENCE_BODY
    );
    expect(result.applicable).toBe(true);
    expect(result.executableAts).toHaveLength(3);
    expect(result.unaddressedAts).toHaveLength(1);
    expect(result.unaddressedAts[0]?.number).toBe(3);
  });

  it("allows when a per-AT deferral marker addresses the unaddressed AT", () => {
    const bodyWithDeferral = `${PROXY_EVIDENCE_BODY}\n[at3-deferred: mt#9999]`;
    const result = checkAcceptanceTestCoverage(
      SPEC_MT2542_3_AT,
      "implementation",
      bodyWithDeferral
    );
    expect(result.applicable).toBe(true);
    expect(result.unaddressedAts).toHaveLength(0);
  });

  it("is not applicable when the task kind is state-ops", () => {
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "state-ops", BODY_NO_EVIDENCE);
    expect(result.applicable).toBe(false);
    expect(result.unaddressedAts).toHaveLength(0);
  });

  it("is not applicable when all ATs are findings-shaped", () => {
    const result = checkAcceptanceTestCoverage(
      SPEC_FINDINGS_ONLY,
      "implementation",
      BODY_NO_EVIDENCE
    );
    expect(result.applicable).toBe(false);
  });

  it("is not applicable when the spec has no Acceptance Tests section (docs-only)", () => {
    const result = checkAcceptanceTestCoverage(
      SPEC_NO_AT_SECTION,
      "implementation",
      BODY_NO_EVIDENCE
    );
    expect(result.applicable).toBe(false);
  });

  it("allows when every executable AT is referenced by number in the evidence block", () => {
    const body = `## Execution evidence:\nAT1 verified. AT2 verified. AT3 verified live boot.\n`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);
    expect(result.unaddressedAts).toHaveLength(0);
  });

  // mt#3078: same mt#2542-shaped scenario, but the spec's Acceptance Tests are written
  // as bullets — the CANONICAL `/create-task` template's format — instead of a numbered
  // list. Pre-fix this returned `applicable: false` (parseAcceptanceTests found nothing),
  // silently skipping the check for the common case.
  it("is applicable and flags the unaddressed AT for a bullet-shaped spec (mt#3078)", () => {
    const bulletSpec = `${AT_SECTION_HEADING}- CREATE TABLE is denied for the DML-only role.
- All 37 tables are granted DML privileges to the role.
- ${AT3_TEXT}
`;
    const result = checkAcceptanceTestCoverage(bulletSpec, "implementation", PROXY_EVIDENCE_BODY);
    expect(result.applicable).toBe(true);
    expect(result.executableAts).toHaveLength(3);
    expect(result.unaddressedAts).toHaveLength(1);
    expect(result.unaddressedAts[0]?.text).toContain(AT3_KEYWORD_FRAGMENT);
  });
});

// mt#3339 (FP-4): the absent-vs-present-elsewhere partition. These assert the CLASSIFICATION
// only — the addressed/unaddressed verdict is deliberately unchanged in both directions, so
// each test pins `unaddressedAts` as well. If a future widening changes that verdict, these
// tests must be updated deliberately rather than silently passing.
describe("checkAcceptanceTestCoverage — present-elsewhere classification (mt#3339)", () => {
  it("classifies an AT as present-elsewhere when its number appears outside the evidence block", () => {
    // AT3's evidence lives under a heading the extractor has no notion of — the real FP-4
    // shape (mt#3149 / PR #2255 used `## SC3 (...)`; mt#2643 / PR #2283 used `## Testing`).
    const body = `${PROXY_EVIDENCE_BODY}\n\n## Testing\n\nAT3 was verified by a live boot of the container.\n`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);

    expect(result.unaddressedAts).toHaveLength(1);
    expect(result.unaddressedAts[0]?.number).toBe(3);
    expect(result.presentElsewhereAts).toHaveLength(1);
    expect(result.presentElsewhereAts[0]?.number).toBe(3);
  });

  it("classifies an AT as absent when its number appears nowhere in the PR body", () => {
    const result = checkAcceptanceTestCoverage(
      SPEC_MT2542_3_AT,
      "implementation",
      PROXY_EVIDENCE_BODY
    );

    expect(result.unaddressedAts).toHaveLength(1);
    expect(result.unaddressedAts[0]?.number).toBe(3);
    expect(result.presentElsewhereAts).toHaveLength(0);
  });

  it("never classifies an addressed AT as present-elsewhere", () => {
    // The partition is a subset of unaddressedAts by construction; an AT referenced INSIDE
    // the block is addressed and must not appear in either list.
    const body = `## Execution evidence:\nAT1 verified. AT2 verified. AT3 verified live boot.\n`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);

    expect(result.unaddressedAts).toHaveLength(0);
    expect(result.presentElsewhereAts).toHaveLength(0);
  });

  // PR #2610 R1 (non-blocking): a PR body that PASTES the gate's own warning, or quotes a
  // spec excerpt, names `AT3` without that being a reference to real evidence. Counting it
  // would inflate the location-gap rate the field exists to measure.
  it("does not count an AT mentioned only inside a fenced block", () => {
    const body = `${PROXY_EVIDENCE_BODY}\n\n## Notes\n\n\`\`\`\nAT3: services boot on the role\n\`\`\`\n`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);

    expect(result.unaddressedAts).toHaveLength(1);
    expect(result.presentElsewhereAts).toEqual([]);
  });

  it("does not count an AT mentioned only in a blockquote or an inline code span", () => {
    const quoted = `${PROXY_EVIDENCE_BODY}\n\n> the gate said AT3 was unaddressed\n`;
    expect(
      checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", quoted).presentElsewhereAts
    ).toEqual([]);

    const inlineCode = `${PROXY_EVIDENCE_BODY}\n\n## Notes\n\nThe warning named \`AT3\` here.\n`;
    expect(
      checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", inlineCode)
        .presentElsewhereAts
    ).toEqual([]);
  });

  it("still counts an AT named in ordinary prose outside the evidence block", () => {
    // The positive control for the elision above: eliding must not swallow the real case.
    const body = `${PROXY_EVIDENCE_BODY}\n\n## Testing\n\nAT3 was verified by a live boot.\n`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);

    expect(result.presentElsewhereAts.map((at) => at.number)).toEqual([3]);
  });

  it("does not classify a deferred AT as present-elsewhere", () => {
    // A `[atN-deferred:]` marker contains the AT number, so a naive full-body number probe
    // would match it. Deferral is resolved BEFORE the partition, so the AT is addressed and
    // appears in neither list.
    const body = `${PROXY_EVIDENCE_BODY}\n[at3-deferred: mt#9999]`;
    const result = checkAcceptanceTestCoverage(SPEC_MT2542_3_AT, "implementation", body);

    expect(result.unaddressedAts).toHaveLength(0);
    expect(result.presentElsewhereAts).toHaveLength(0);
  });
});

// mt#3339 Success Criterion 5 (absorbed from mt#3277 SC3). The fence-tracking fix shipped
// with mt#3316 in `e927edff9`; NOTHING pinned it. This does, using PR #2353's REAL body
// (11,458 bytes on disk, fetched from GitHub) and mt#3262's REAL `## Acceptance Tests`.
//
// Why this body specifically: its `Execution evidence:` block is a fenced shell transcript
// whose lines include `# AT2 …` comments. Before the fence fix, the heading scan treated
// those `#` lines as real Markdown headings and stopped the block at the first one — the
// extracted evidence was a 216-character fragment, and AT2-AT5 were all reported unaddressed
// on a PR that documented every one of them.
//
// Both fixtures are pinned FILES, not live fetches: a unit test that reaches for a task spec
// or a PR body over the network would silently change meaning whenever either is edited.
describe("extractExecutionEvidenceText — PR #2353 fenced-transcript regression (mt#3339 SC5)", () => {
  /* eslint-disable custom/no-real-fs-in-tests -- these read PINNED fixture files checked
     into `__fixtures__/`, which is the point of the test: the regression guard is only
     meaningful against PR #2353's REAL 11,458-byte body and mt#3262's REAL acceptance
     tests. Inlining 11KB of Markdown as a string literal, or mocking the read, would
     substitute a hand-summarized body for the artifact whose exact shape (a fenced shell
     transcript with `# AT<n>` comment lines) is what triggered the bug. */
  const PR_2353_BODY = readFileSync(join(import.meta.dir, "__fixtures__/pr-2353-body.md"), "utf-8");
  const MT_3262_ATS = readFileSync(
    join(import.meta.dir, "__fixtures__/mt-3262-acceptance-tests.md"),
    "utf-8"
  );
  /* eslint-enable custom/no-real-fs-in-tests */

  /** The pre-fix truncation length, from mt#3277's write-up — the bug's signature. */
  const PRE_FIX_FRAGMENT_LENGTH = 216;

  it("extracts the whole evidence section, not the pre-fix 216-character fragment", () => {
    const evidence = extractExecutionEvidenceText(PR_2353_BODY);

    expect(evidence.length).toBeGreaterThan(PRE_FIX_FRAGMENT_LENGTH * 4);
    // The `# AT<n>` comment lines are INSIDE the fence — the exact content the pre-fix scan
    // truncated at. Their presence is what distinguishes "the fence fix works" from "the
    // block happened to be long".
    expect(evidence).toContain("# AT2");
    expect(evidence).toContain("# AT5");
  });

  it("resolves AT1-AT5 as referenced, reporting zero unaddressed", () => {
    const result = checkAcceptanceTestCoverage(MT_3262_ATS, "implementation", PR_2353_BODY);

    expect(result.applicable).toBe(true);
    expect(result.executableAts).toHaveLength(5);
    expect(result.unaddressedAts).toEqual([]);
    // Nothing is unaddressed, so nothing can be a location gap either (mt#3339).
    expect(result.presentElsewhereAts).toEqual([]);
  });
});

describe("isAtCoverageSkipped", () => {
  const ORIGINAL = process.env[AT_COVERAGE_SKIP_ENV_VAR];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[AT_COVERAGE_SKIP_ENV_VAR];
    else process.env[AT_COVERAGE_SKIP_ENV_VAR] = ORIGINAL;
  });

  it("is false by default", () => {
    delete process.env[AT_COVERAGE_SKIP_ENV_VAR];
    expect(isAtCoverageSkipped()).toBe(false);
  });

  it("is true when set to '1'", () => {
    process.env[AT_COVERAGE_SKIP_ENV_VAR] = "1";
    expect(isAtCoverageSkipped()).toBe(true);
  });

  it("is true when set to 'true' (case-insensitive)", () => {
    process.env[AT_COVERAGE_SKIP_ENV_VAR] = "TRUE";
    expect(isAtCoverageSkipped()).toBe(true);
  });
});

describe("fetchTaskSpecForAtCoverage", () => {
  it("parses a successful CLI response", () => {
    const exec: ExecFn = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        task: { kind: "implementation" },
        content: SPEC_MT2542_3_AT,
      }),
      stderr: "",
    });
    const result = fetchTaskSpecForAtCoverage("mt#2542", "/tmp", exec);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("implementation");
    expect(result.content).toContain(AT3_KEYWORD_FRAGMENT);
  });

  it("fails open (ok: false) on non-zero exit", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "not found" });
    expect(fetchTaskSpecForAtCoverage("mt#9999999", "/tmp", exec).ok).toBe(false);
  });

  it("fails open (ok: false) on unparseable JSON", () => {
    const exec: ExecFn = () => ({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(fetchTaskSpecForAtCoverage("mt#1", "/tmp", exec).ok).toBe(false);
  });

  it("fails open (ok: false) when the content field is missing", () => {
    const exec: ExecFn = () => ({
      exitCode: 0,
      stdout: JSON.stringify({ success: true, task: { kind: "implementation" } }),
      stderr: "",
    });
    expect(fetchTaskSpecForAtCoverage("mt#1", "/tmp", exec).ok).toBe(false);
  });

  it("fails open (ok: false) when exec itself throws", () => {
    const exec: ExecFn = () => {
      throw new Error("spawn failed");
    };
    expect(fetchTaskSpecForAtCoverage("mt#1", "/tmp", exec).ok).toBe(false);
  });
});

describe("runAtCoverageCalibration — never emits deny, only warns/logs", () => {
  const ORIGINAL_SKIP = process.env[AT_COVERAGE_SKIP_ENV_VAR];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "at-coverage-calibration-"));
    delete process.env[AT_COVERAGE_SKIP_ENV_VAR];
  });

  afterEach(() => {
    if (ORIGINAL_SKIP === undefined) delete process.env[AT_COVERAGE_SKIP_ENV_VAR];
    else process.env[AT_COVERAGE_SKIP_ENV_VAR] = ORIGINAL_SKIP;
    // eslint-disable-next-line custom/no-real-fs-in-tests -- cleans up the real mkdtemp scratch directory created in beforeEach above.
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function execFor(specContent: string, kind = "implementation"): ExecFn {
    return () => ({
      exitCode: 0,
      stdout: JSON.stringify({ success: true, task: { kind }, content: specContent }),
      stderr: "",
    });
  }

  it("returns a warning (never a block-shaped result) for the mt#2542 scenario, naming AT3", () => {
    const result = runAtCoverageCalibration(
      "mt#2542",
      2136,
      PROXY_EVIDENCE_BODY,
      "/tmp",
      tmpDir,
      execFor(SPEC_MT2542_3_AT)
    );
    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("AT3");
    expect(result.warning).toContain("CALIBRATION");
    // Structural guarantee: the result shape has no field resembling a deny/block signal.
    expect(Object.keys(result).sort()).toEqual(["ranCheck", "warning"]);
    expect(JSON.stringify(result)).not.toContain("permissionDecision");
    expect(JSON.stringify(result).toLowerCase()).not.toContain('"blocked"');

    // mt#4755: the record now lands in the STATE DIR, not under the given repo root — that
    // relocation is the whole task, and this assertion is what proves it rather than merely
    // permitting it. Resolved through `calibrationLogPath`, the READER's own function, not a
    // hand-written path: a hand-written expectation would pass just as happily while writer and
    // reader disagreed, which is exactly the state mt#4811 found live in `ask-form-lint`.
    const logPath = calibrationLogPath(AT_COVERAGE_STREAM, { projectDir: tmpDir });
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads back the real calibration-log file `runAtCoverageCalibration` just wrote, to verify the on-disk record shape.
    const written = readFileSync(logPath, "utf-8");
    const record = JSON.parse(written.trim().split("\n")[0] ?? "{}");
    expect(record.task).toBe("mt#2542");
    expect(record.unaddressedAts?.[0]?.number).toBe(3);

    // PR #2610 R1 (non-blocking): pin the ON-DISK record shape a downstream consumer reads.
    // `scripts/at-coverage-reclassify.ts` parses this log, so a renamed or dropped key is a
    // silent breakage there rather than a test failure here. Assert the pre-existing keys are
    // intact ALONGSIDE the mt#3339 addition — the addition is only safe because it is additive.
    expect(Object.keys(record).sort()).toEqual([
      // mt#3607's judged-input capture — added ALONGSIDE the pre-existing keys,
      // which is what makes it safe for `scripts/at-coverage-reclassify.ts`.
      "captureSchema",
      "executableAtCount",
      "judgedPrBody",
      "judgedSpec",
      "prNumber",
      "presentElsewhereAts",
      "surface",
      "task",
      "timestamp",
      "unaddressedAts",
    ]);
    // AT3 is absent from this body entirely (proxy evidence names no AT number), so the
    // partition records it as NOT present-elsewhere — the field is written either way.
    expect(record.presentElsewhereAts).toEqual([]);
  });

  it("returns no warning when every executable AT is deferred or covered", () => {
    const bodyWithDeferral = `${PROXY_EVIDENCE_BODY}\n[at3-deferred: mt#9999]`;
    const result = runAtCoverageCalibration(
      "mt#2542",
      2136,
      bodyWithDeferral,
      "/tmp",
      tmpDir,
      execFor(SPEC_MT2542_3_AT)
    );
    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("returns no warning for a docs-only PR bound to a task with no executable ATs", () => {
    const result = runAtCoverageCalibration(
      "mt#1",
      1,
      BODY_NO_EVIDENCE,
      "/tmp",
      tmpDir,
      execFor(SPEC_NO_AT_SECTION)
    );
    expect(result.ranCheck).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("is silent (ranCheck: false) when the spec fetch fails — fail-open, no noise", () => {
    const failingExec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "not found" });
    const result = runAtCoverageCalibration(
      "mt#nonexistent",
      1,
      PROXY_EVIDENCE_BODY,
      "/tmp",
      tmpDir,
      failingExec
    );
    expect(result.ranCheck).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("is skipped entirely when MINSKY_SKIP_AT_COVERAGE is set", () => {
    process.env[AT_COVERAGE_SKIP_ENV_VAR] = "1";
    const result = runAtCoverageCalibration(
      "mt#2542",
      2136,
      PROXY_EVIDENCE_BODY,
      "/tmp",
      tmpDir,
      execFor(SPEC_MT2542_3_AT)
    );
    expect(result.ranCheck).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});
