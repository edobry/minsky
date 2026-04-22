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
// One of many files is modified → stale. Exercises the full compileRules
// orchestration for the multi-file cursor-rules target via the DI seam.

describe("cursor-rules multi-file staleness (d)", () => {
  it("one of many files modified → compileRules identifies the stale file", async () => {
    const rules = [
      makeRule("rule-a", "Content A"),
      makeRule("rule-b", "Content B"),
      makeRule("rule-c", "Content C"),
    ];

    // Seed output dir: rule-a/c match expected content; rule-b is corrupted.
    const { files: expected } = buildCursorRulesContent(rules, OUTPUT_DIR);
    const initialFiles: Record<string, string> = {};
    for (const { path: filePath, content } of expected) {
      initialFiles[filePath] = filePath.endsWith("rule-b.mdc") ? "WRONG CONTENT" : content;
    }

    // Inject a stub RuleService that returns the rules directly, skipping the
    // listRules filesystem path (which suffers cross-test pollution in the full
    // suite — tracked separately; the DI seam itself is what we're verifying).
    const fs = createMockFs(initialFiles);
    const ruleService = {
      listRules: async () => rules,
    } as unknown as RuleService;

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
    expect(result.staleFile).toContain("rule-b.mdc");
  });
});
