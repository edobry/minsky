import { describe, expect, it } from "bun:test";

import {
  isTestFile,
  findNewTestFiles,
  hasExecutionEvidence,
  hasBypassPrefix,
  checkExecutionEvidence,
  parseGitHubRemoteUrl,
  type PrFile,
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
});

// ---------------------------------------------------------------------------
// hasBypassPrefix
// ---------------------------------------------------------------------------

describe("hasBypassPrefix", () => {
  it("detects exact prefix", () => {
    expect(hasBypassPrefix(TITLE_BYPASS)).toBe(true);
  });

  it("detects uppercase variant", () => {
    expect(hasBypassPrefix("[UNVERIFIED-TESTS] Add new session tests")).toBe(true);
  });

  it("detects mixed case", () => {
    expect(hasBypassPrefix("[Unverified-Tests] My PR title")).toBe(true);
  });

  it("returns false when prefix is absent", () => {
    expect(hasBypassPrefix("Add new session tests")).toBe(false);
    expect(hasBypassPrefix("Add [unverified-tests] tests")).toBe(false);
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

  it("does NOT bypass when [unverified-tests] is in the middle of the title", () => {
    // Bypass only fires when prefix is at the START of the title
    const files: PrFile[] = [{ filename: FIXTURE_FOO_TEST_TS, status: "added" }];
    const result = checkExecutionEvidence(files, "Add [unverified-tests] tests", BODY_NO_EVIDENCE);
    // Should block because prefix is not at start and no evidence present
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
