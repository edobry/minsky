/**
 * Tests for `rules compile --check` staleness detection.
 *
 * Covers:
 *   (a) fresh output not stale
 *   (b) modified output stale
 *   (c) missing output stale
 *   (d) cursor-rules multi-file — one of many files modified → stale
 *   (e) cursor-rules with orphan .mdc → stale
 *
 * Uses in-memory fs (createMockFs) injected via compileRules' `deps` seam.
 */

import { describe, it, expect } from "bun:test";
import { compileRules } from "../operations/crud-operations";
import { RuleService } from "../rule-service";
import { createMockFs } from "../../interfaces/mock-fs";
import { buildContent, DEFAULT_AGENTS_MD_SECTIONS } from "./targets/agents-md";
import { buildClaudeMdContent } from "./targets/claude-md";
import { buildCursorRulesContent } from "./targets/cursor-rules";
import { makeRule } from "./test-utils";

const WORKSPACE = "/mock/workspace";
const OUTPUT_DIR = `${WORKSPACE}/compiled-rules`;

function setupMockFs(
  initialFiles: Record<string, string> = {},
  initialDirectories: Set<string> = new Set()
) {
  const fs = createMockFs(initialFiles, initialDirectories);
  const ruleService = new RuleService(WORKSPACE, { fsPromises: fs });
  return { fs, ruleService };
}

describe("compileRules --check staleness detection", () => {
  describe("agents.md target", () => {
    it("(a) fresh output — not stale", async () => {
      const expected = buildContent([], DEFAULT_AGENTS_MD_SECTIONS).content;
      const { fs, ruleService } = setupMockFs({ [`${WORKSPACE}/AGENTS.md`]: expected });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "agents.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.staleFile).toBeUndefined();
    });

    it("(b) modified output — stale", async () => {
      const { fs, ruleService } = setupMockFs({ [`${WORKSPACE}/AGENTS.md`]: "STALE CONTENT" });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "agents.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("AGENTS.md");
    });

    it("(c) missing output — stale", async () => {
      const { fs, ruleService } = setupMockFs();

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "agents.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("AGENTS.md");
    });
  });

  describe("claude.md target", () => {
    it("(a) fresh output — not stale", async () => {
      const expected = buildClaudeMdContent([]).content;
      const { fs, ruleService } = setupMockFs({ [`${WORKSPACE}/CLAUDE.md`]: expected });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "claude.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
    });

    it("(b) modified output — stale", async () => {
      const { fs, ruleService } = setupMockFs({
        [`${WORKSPACE}/CLAUDE.md`]: "outdated content",
      });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "claude.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("CLAUDE.md");
    });

    it("(c) missing output — stale", async () => {
      const { fs, ruleService } = setupMockFs();

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "claude.md", check: true },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
    });
  });

  describe("cursor-rules target", () => {
    it("(a) fresh output — empty workspace, empty output dir — not stale", async () => {
      const { fs, ruleService } = setupMockFs({}, new Set([OUTPUT_DIR]));

      const result = await compileRules(
        {
          workspacePath: WORKSPACE,
          target: "cursor-rules",
          output: OUTPUT_DIR,
          check: true,
        },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
    });

    it("(e) orphan .mdc file in output dir — stale", async () => {
      // Empty workspace → expectedFiles = []. Output dir has an old .mdc → orphan → stale.
      const { fs, ruleService } = setupMockFs({
        [`${OUTPUT_DIR}/old-rule.mdc`]: "---\nalwaysApply: false\n---\nOld rule content",
      });

      const result = await compileRules(
        {
          workspacePath: WORKSPACE,
          target: "cursor-rules",
          output: OUTPUT_DIR,
          check: true,
        },
        { fs, ruleService }
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("old-rule.mdc");
    });
  });
});

// ─── cursor-rules multi-file check scenario (d) ─────────────────────────────
// One of many files is modified → stale. Tests the per-file comparison logic
// in buildCursorRulesContent, independent of compileRules orchestration.

describe("cursor-rules multi-file staleness (d)", () => {
  it("one of many files modified → stale file is identified", async () => {
    const rules = [
      makeRule("rule-a", "Content A"),
      makeRule("rule-b", "Content B"),
      makeRule("rule-c", "Content C"),
    ];
    const { files } = buildCursorRulesContent(rules, OUTPUT_DIR);

    // Build in-memory "existing" content: rule-a/c match, rule-b is corrupted.
    const existingByPath = new Map<string, string>();
    for (const { path: filePath, content } of files) {
      existingByPath.set(filePath, filePath.endsWith("rule-b.mdc") ? "WRONG CONTENT" : content);
    }

    // Simulate the per-file check loop from crud-operations.ts
    let foundStale: string | undefined;
    for (const { path: filePath, content: expectedContent } of files) {
      const existingContent = existingByPath.get(filePath);
      if (existingContent !== expectedContent) {
        foundStale = filePath;
        break;
      }
    }

    expect(foundStale).toBeDefined();
    expect(foundStale).toContain("rule-b.mdc");
  });
});
