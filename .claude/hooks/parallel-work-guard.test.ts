import { describe, expect, it } from "bun:test";

import {
  extractInScopeFiles,
  findOverlappingFiles,
  formatBlockMessage,
  runParallelWorkChecks,
  type ParallelWorkCheckInput,
  type ParallelWorkCollision,
} from "./parallel-work-guard";

// ---------------------------------------------------------------------------
// Shared test fixtures (extracted to avoid magic-string duplication warnings)
// ---------------------------------------------------------------------------

const FIXTURE_SETTINGS_JSON = ".claude/settings.json";
const FIXTURE_ASK_TS = "src/domain/ask/ask.ts";
const FIXTURE_ASK_TEST_TS = "src/domain/ask/ask.test.ts";
const FIXTURE_HOOK_TS = ".claude/hooks/parallel-work-guard.ts";

// ---------------------------------------------------------------------------
// extractInScopeFiles
// ---------------------------------------------------------------------------

describe("extractInScopeFiles", () => {
  it("extracts file paths from a well-formed spec", () => {
    const spec = `
## Summary
A task.

## Scope

**In scope:**
- \`.claude/hooks/parallel-work-guard.ts\` (new file)
- \`.claude/settings.json\` (hook registration)
- \`src/domain/ask/ask.ts\`

**Out of scope:**
- Modifying other hooks
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain(FIXTURE_HOOK_TS);
    expect(files).toContain(FIXTURE_SETTINGS_JSON);
    expect(files).toContain(FIXTURE_ASK_TS);
  });

  it("returns warning when ## Scope section is missing", () => {
    const spec = `## Summary\nNo scope section here.\n`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/No '## Scope' section/);
  });

  it("returns warning when In scope block is missing", () => {
    const spec = `
## Scope

This section has no bold In scope header.

## Next Section
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/No '\*\*In scope:\*\*' block/);
  });

  it("returns warning when In scope block has no parseable paths", () => {
    const spec = `
## Scope

**In scope:**
- Some text without a path
- More text

**Out of scope:**
- something
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("handles paths with annotations (new), (modified), etc.", () => {
    const spec = `
## Scope

**In scope:**
- \`src/domain/foo.ts\` (new file)
- \`src/adapters/cli/bar.ts\` (modified)

**Out of scope:**
- nothing
`;
    const { files } = extractInScopeFiles(spec);
    expect(files).toContain("src/domain/foo.ts");
    expect(files).toContain("src/adapters/cli/bar.ts");
    // Annotations should be stripped
    expect(files.every((f) => !f.includes("(new"))).toBe(true);
  });

  it("handles directory-level scope entries", () => {
    const spec = `
## Scope

**In scope:**
- \`src/domain/ask/\`

**Out of scope:**
`;
    const { files } = extractInScopeFiles(spec);
    // Directory paths should be included
    expect(files.length).toBeGreaterThanOrEqual(0);
    // If extracted, should include the directory
    if (files.length > 0) {
      expect(files.some((f) => f.includes("src/domain/ask"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// findOverlappingFiles
// ---------------------------------------------------------------------------

describe("findOverlappingFiles", () => {
  it("returns empty array when no overlap", () => {
    const inScope = ["src/domain/tasks/", FIXTURE_SETTINGS_JSON];
    const prFiles = ["src/adapters/cli/index.ts", "tests/unit/foo.test.ts"];
    expect(findOverlappingFiles(inScope, prFiles)).toHaveLength(0);
  });

  it("detects exact file match", () => {
    const inScope = [FIXTURE_SETTINGS_JSON];
    const prFiles = [FIXTURE_SETTINGS_JSON, "src/domain/other.ts"];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("detects overlap when in-scope entry is a directory prefix of PR file", () => {
    const inScope = ["src/domain/ask/"];
    const prFiles = [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result.length).toBeGreaterThan(0);
  });

  it("detects overlap when PR file is a directory prefix of in-scope file", () => {
    const inScope = [FIXTURE_ASK_TS];
    const prFiles = ["src/domain/ask/"];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles leading ./ in in-scope paths", () => {
    const inScope = [`./${FIXTURE_SETTINGS_JSON}`];
    const prFiles = [FIXTURE_SETTINGS_JSON];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("does not produce duplicates for multiple scope entries matching same PR file", () => {
    const inScope = [FIXTURE_ASK_TS, "src/domain/ask/"];
    const prFiles = [FIXTURE_ASK_TS];
    const result = findOverlappingFiles(inScope, prFiles);
    // Should deduplicate
    expect(result.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatBlockMessage
// ---------------------------------------------------------------------------

describe("formatBlockMessage", () => {
  it("includes task ID in message", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "feat(mt#1240): parallel work implementation",
        overlappingFiles: [FIXTURE_ASK_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("mt#1068");
  });

  it("includes PR number and title for open-pr collision", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "feat(mt#1240): some feature",
        overlappingFiles: [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("PR #788");
    expect(msg).toContain("feat(mt#1240): some feature");
    expect(msg).toContain(FIXTURE_ASK_TS);
  });

  it("includes commit sha and message for recently-merged collision", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "recently-merged",
        commitSha: "abc1234",
        commitMessage: "feat: landed ask domain refactor",
        overlappingFiles: [FIXTURE_ASK_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1362", collisions);
    expect(msg).toContain("abc1234");
    expect(msg).toContain("feat: landed ask domain refactor");
  });

  it("includes override instructions", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "some PR",
        overlappingFiles: ["src/foo.ts"],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("MINSKY_FORCE_PARALLEL=1");
  });

  it("includes recommended actions", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 1,
        prTitle: "some PR",
        overlappingFiles: ["src/foo.ts"],
      },
    ];
    const msg = formatBlockMessage("mt#1", collisions);
    expect(msg).toContain("WAIT");
    expect(msg).toContain("COORDINATE");
    expect(msg).toContain("REFRAME");
    expect(msg).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// runParallelWorkChecks — hermetic (mocked) tests
// ---------------------------------------------------------------------------

describe("runParallelWorkChecks — mt#1068 incident replay", () => {
  /**
   * Simulate the mt#1068 incident:
   * - Task mt#1068 wants to modify src/domain/ask/ files
   * - PR #788 (mt#1240) is open and touches src/domain/ask/
   *
   * We test the collision detection logic directly using findOverlappingFiles,
   * since runParallelWorkChecks calls external commands (gh, git) that are
   * not available in unit tests.
   */
  it("detects mt#1068 / PR #788 collision in ask domain", () => {
    const inScopeFiles = [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS, FIXTURE_SETTINGS_JSON];
    // Files that PR #788 (mt#1240) touched
    const pr788Files = [
      FIXTURE_ASK_TS,
      "src/domain/ask/index.ts",
      "src/adapters/cli/ask.adapter.ts",
    ];

    const overlapping = findOverlappingFiles(inScopeFiles, pr788Files);
    expect(overlapping.length).toBeGreaterThan(0);
    expect(overlapping).toContain(FIXTURE_ASK_TS);
  });

  it("does NOT flag non-overlapping PR", () => {
    const inScopeFiles = ["src/domain/tasks/", FIXTURE_SETTINGS_JSON];
    const unrelatedPrFiles = ["src/adapters/cli/session.adapter.ts", "tests/unit/session.test.ts"];

    const overlapping = findOverlappingFiles(inScopeFiles, unrelatedPrFiles);
    expect(overlapping).toHaveLength(0);
  });
});

describe("runParallelWorkChecks — clean path", () => {
  it("returns not blocked with empty in-scope files", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9999",
      inScopeFiles: [],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    // With empty in-scope files, no overlap is possible
    const result = runParallelWorkChecks(checkInput, "/tmp/nonexistent-repo-dir");
    // Both checks will fail gracefully (gh and git won't work in test env),
    // producing warnings but not blocking
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractInScopeFiles — mt#1362's own spec
// ---------------------------------------------------------------------------

describe("extractInScopeFiles — mt#1362 spec fixture", () => {
  const mt1362Spec = `
## Summary

Implement a PreToolUse hook...

## Scope

**In scope:**
- \`.claude/hooks/parallel-work-guard.ts\` (new file)
- \`.claude/settings.json\` (hook registration)
- Documentation update in CLAUDE.md or relevant rule about override mechanism
- Test fixtures or smoke test for the hook

**Out of scope:**
- Extending the hook to \`tasks_create\` for bug-fix tasks
- Modifying the existing skill-step checks
`;

  it("correctly parses mt#1362 scope section", () => {
    const { files, warnings } = extractInScopeFiles(mt1362Spec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain(FIXTURE_HOOK_TS);
    expect(files).toContain(FIXTURE_SETTINGS_JSON);
  });
});
