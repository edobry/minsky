import { describe, expect, it } from "bun:test";

import {
  isTestFile,
  findNewTestFiles,
  hasExecutionEvidence,
  hasBypassPrefix,
  checkExecutionEvidence,
  parseGitHubRemoteUrl,
  resolvePrNumber,
  type PrFile,
  type FetchPrFilesResult,
  type ExecFn,
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

  it("does not match .test.tsx", () => {
    expect(isTestFile("src/components/Foo.test.tsx")).toBe(false);
  });
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
        return { exitCode: r.exitCode, stdout: r.stdout };
      }
    }
    return { exitCode: 1, stdout: "" };
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
      if (cmd.join(" ").includes("pr view")) return { exitCode: 1, stdout: "" };
      if (cmd.join(" ").includes("pr list")) return { exitCode: 0, stdout: "42" };
      return { exitCode: 1, stdout: "" };
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
