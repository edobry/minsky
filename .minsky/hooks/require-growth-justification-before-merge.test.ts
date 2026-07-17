#!/usr/bin/env bun
// Unit tests for the growth-justification merge gate (mt#2874).
//
// Covers: rules-dir file matching, the mt#2648 marker-acceptance forms
// (both shapes), delta computation at the 2,000-char boundary, the
// reduction-never-triggers rule, and the fail-open/silent paths.

import { describe, test, expect, afterAll } from "bun:test";
import {
  isRulesDirFile,
  findRulesDirFiles,
  hasSizeBudgetJustification,
  checkGrowthJustification,
  isOverrideSet,
  GROWTH_THRESHOLD_CHARS,
  OVERRIDE_ENV_VAR,
  RULES_DIR_PREFIX,
} from "./require-growth-justification-before-merge";
import type { PrFile } from "./pr-context";

function makeFile(filename: string, status: PrFile["status"] = "modified"): PrFile {
  return { filename, status, previous_filename: null };
}

/** Shared fixture path, reused across several describe blocks below (lint: no-magic-string-duplication). */
const HOOK_FILES_RULE = ".minsky/rules/hook-files.mdc";

// ---------------------------------------------------------------------------
// isRulesDirFile / findRulesDirFiles
// ---------------------------------------------------------------------------

describe("isRulesDirFile", () => {
  test("matches a file under .minsky/rules/", () => {
    expect(isRulesDirFile(HOOK_FILES_RULE)).toBe(true);
  });

  test("matches the prefix directory itself as a substring boundary", () => {
    expect(isRulesDirFile(`${RULES_DIR_PREFIX}decision-defaults.mdc`)).toBe(true);
  });

  test("does not match a file outside .minsky/rules/", () => {
    expect(isRulesDirFile("src/hooks/pre-commit.ts")).toBe(false);
    expect(isRulesDirFile(".minsky/hooks/pr-context.ts")).toBe(false);
    expect(isRulesDirFile("CLAUDE.md")).toBe(false);
  });

  test("is null/undefined-safe", () => {
    expect(isRulesDirFile(null)).toBe(false);
    expect(isRulesDirFile(undefined)).toBe(false);
  });
});

describe("findRulesDirFiles", () => {
  test("returns files whose filename is under .minsky/rules/", () => {
    const files = [
      makeFile(HOOK_FILES_RULE),
      makeFile("src/index.ts"),
      makeFile(".minsky/rules/key-architecture.mdc"),
    ];
    expect(findRulesDirFiles(files)).toEqual([
      HOOK_FILES_RULE,
      ".minsky/rules/key-architecture.mdc",
    ]);
  });

  test("returns empty array when no files touch the rules dir", () => {
    const files = [makeFile("src/index.ts"), makeFile("docs/readme.md")];
    expect(findRulesDirFiles(files)).toEqual([]);
  });

  test("counts a rename AWAY from .minsky/rules/ via previous_filename", () => {
    const files: PrFile[] = [
      {
        filename: "docs/archived-rule.md",
        status: "renamed",
        previous_filename: ".minsky/rules/old-rule.mdc",
      },
    ];
    expect(findRulesDirFiles(files)).toEqual(["docs/archived-rule.md"]);
  });

  test("counts a rename INTO .minsky/rules/ via filename", () => {
    const files: PrFile[] = [
      {
        filename: ".minsky/rules/new-rule.mdc",
        status: "renamed",
        previous_filename: "scratch/draft.mdc",
      },
    ];
    expect(findRulesDirFiles(files)).toEqual([".minsky/rules/new-rule.mdc"]);
  });
});

// ---------------------------------------------------------------------------
// hasSizeBudgetJustification — mt#2648 marker forms
// ---------------------------------------------------------------------------

describe("hasSizeBudgetJustification", () => {
  test("accepts the plain-label form with a colon", () => {
    const body = "## Summary\n\nSize-budget justification: this rule fires every turn.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });

  test("accepts a Markdown heading form with a trailing colon", () => {
    const body = "## Size-budget justification:\n\nThis content must be always-loaded because X.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });

  test("accepts a Markdown heading form WITHOUT a trailing colon", () => {
    const body = "### Size-budget justification\n\nRationale here.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });

  test("accepts any heading level 1-6", () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = "#".repeat(level);
      const body = `${hashes} Size-budget justification\n\nContent.`;
      expect(hasSizeBudgetJustification(body)).toBe(true);
    }
  });

  test("is case-insensitive", () => {
    const body = "SIZE-BUDGET JUSTIFICATION: uppercase content here.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });

  test("rejects a plain-label form WITHOUT a colon", () => {
    const body = "Size-budget justification this content matters.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("rejects a negated marker", () => {
    const body = "No Size-budget justification: needed here, trivial change.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("rejects a negated Markdown heading", () => {
    const body = "## No Size-budget justification needed\n\nSee above.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("rejects a marker with no following content", () => {
    const body = "## Size-budget justification\n\n## Next Section\n\nOther content.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("ignores a marker inside an HTML comment", () => {
    const body = "<!-- Size-budget justification: hidden -->\n\nActual body text.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("returns false when the marker is entirely absent", () => {
    const body = "## Summary\n\nJust a normal PR body with no marker.";
    expect(hasSizeBudgetJustification(body)).toBe(false);
  });

  test("accepts inline content on the same line as the plain label", () => {
    const body = "Size-budget justification: fires every turn, no cheaper channel fits.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });

  test("accepts content on a subsequent line after a heading with no inline content", () => {
    const body = "## Size-budget justification:\nContent on the next line.";
    expect(hasSizeBudgetJustification(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkGrowthJustification — delta computation + boundary + reduction rule
// ---------------------------------------------------------------------------

describe("checkGrowthJustification", () => {
  const RULES_FILES = [makeFile(HOOK_FILES_RULE)];
  const NON_RULES_FILES = [makeFile("src/index.ts")];

  test("is silent (never blocks) when the PR does not touch .minsky/rules/**", () => {
    const result = checkGrowthJustification(NON_RULES_FILES, "", 200_000, 100_000);
    expect(result.blocked).toBe(false);
    expect(result.rulesFiles).toEqual([]);
    expect(result.deltaChars).toBeNull();
  });

  test("computes delta as headSizeChars - baseSizeChars", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 114_500, 111_000);
    expect(result.deltaChars).toBe(3500);
  });

  test("blocks growth strictly above the threshold with no marker", () => {
    const result = checkGrowthJustification(RULES_FILES, "no marker here", 103_000, 100_000);
    expect(result.deltaChars).toBe(3000);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("3000 chars");
    expect(result.reason).toContain("Size-budget justification:");
    expect(result.reason).toContain("Rule-admission ladder");
    expect(result.reason).toContain(OVERRIDE_ENV_VAR);
  });

  test("allows growth strictly above the threshold WITH a marker present", () => {
    const body = "Size-budget justification: this check runs every turn, no cheaper channel fits.";
    const result = checkGrowthJustification(RULES_FILES, body, 103_000, 100_000);
    expect(result.blocked).toBe(false);
    expect(result.justificationFound).toBe(true);
  });

  test("allows growth of 1.5K (under the 2K threshold) without a marker", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 101_500, 100_000);
    expect(result.deltaChars).toBe(1500);
    expect(result.blocked).toBe(false);
  });

  test("boundary: growth exactly AT the threshold (2000) does not trigger", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 102_000, 100_000);
    expect(result.deltaChars).toBe(GROWTH_THRESHOLD_CHARS);
    expect(result.blocked).toBe(false);
  });

  test("boundary: growth one char ABOVE the threshold (2001) triggers without a marker", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 102_001, 100_000);
    expect(result.deltaChars).toBe(GROWTH_THRESHOLD_CHARS + 1);
    expect(result.blocked).toBe(true);
  });

  test("thresholdChars override (mt#2874 §7a live-verification seam): a real sub-2000 delta blocks under a lowered test threshold", () => {
    // Mirrors the live-verification exercise: growth of 1936 chars (a REAL
    // historical delta, PR #1935/mt#2801) is under the production 2000
    // threshold but exceeds a deliberately lowered test threshold.
    const result = checkGrowthJustification(RULES_FILES, "", 101_936, 100_000, 1000);
    expect(result.deltaChars).toBe(1936);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("1936 chars");
    expect(result.reason).toContain("threshold: 1000 chars");
  });

  test("thresholdChars override does not affect the reduction-never-triggers rule", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 99_000, 100_000, 1);
    expect(result.deltaChars).toBe(-1000);
    expect(result.blocked).toBe(false);
  });

  test("a reduction never triggers, even a large one, regardless of marker absence", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 90_000, 140_000);
    expect(result.deltaChars).toBe(-50_000);
    expect(result.blocked).toBe(false);
  });

  test("a reduction on a rules-touching PR is silent (no warnings, no block)", () => {
    const result = checkGrowthJustification(RULES_FILES, "", 90_000, 100_000);
    expect(result.blocked).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test("deny message lists the touched rules files", () => {
    const files = [makeFile(HOOK_FILES_RULE), makeFile(".minsky/rules/decision-defaults.mdc")];
    const result = checkGrowthJustification(files, "", 103_000, 100_000);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(HOOK_FILES_RULE);
    expect(result.reason).toContain(".minsky/rules/decision-defaults.mdc");
  });
});

// ---------------------------------------------------------------------------
// isOverrideSet
// ---------------------------------------------------------------------------

describe("isOverrideSet", () => {
  const original = process.env[OVERRIDE_ENV_VAR];

  afterAll(() => {
    if (original === undefined) {
      delete process.env[OVERRIDE_ENV_VAR];
    } else {
      process.env[OVERRIDE_ENV_VAR] = original;
    }
  });

  test("is false when the env var is unset", () => {
    delete process.env[OVERRIDE_ENV_VAR];
    expect(isOverrideSet()).toBe(false);
  });

  test("is true for '1'", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    expect(isOverrideSet()).toBe(true);
  });

  test("is true for 'true'", () => {
    process.env[OVERRIDE_ENV_VAR] = "true";
    expect(isOverrideSet()).toBe(true);
  });

  test("is false for an unrecognized value", () => {
    process.env[OVERRIDE_ENV_VAR] = "nope";
    expect(isOverrideSet()).toBe(false);
  });
});
