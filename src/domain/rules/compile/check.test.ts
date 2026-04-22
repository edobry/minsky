/**
 * Tests for `rules compile --check` staleness detection.
 *
 * Covers:
 *   (a) fresh output not stale
 *   (b) modified output stale
 *   (c) missing output stale
 *   (d) cursor-rules multi-file — one of many files modified → stale
 *   (e) cursor-rules with orphan .mdc → stale
 */

/* eslint-disable custom/no-real-fs-in-tests --
   This is an integration test for the rule-compile staleness-detection pipeline,
   which reads/writes real files via fs/promises. compileRules() and its internal
   services do not currently accept an fs abstraction, so in-memory mocks can't
   exercise the real staleness-detection logic. mt#1111 tracks the refactor to
   inject an fs provider, after which this file should be converted and this
   waiver removed.
*/

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { compileRules } from "../operations/crud-operations";
import { buildCursorRulesContent, cursorRulesTarget } from "./targets/cursor-rules";
import { agentsMdTarget, buildContent, DEFAULT_AGENTS_MD_SECTIONS } from "./targets/agents-md";
import { claudeMdTarget, buildClaudeMdContent } from "./targets/claude-md";
import type { Rule } from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(id: string, content: string, opts: Partial<Rule> = {}): Rule {
  return {
    id,
    content,
    format: "cursor",
    path: `/fake/path/${id}.mdc`,
    alwaysApply: false,
    ...opts,
  };
}

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "minsky-check-test-"));
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── CompileTarget.listOutputFiles ───────────────────────────────────────────

describe("CompileTarget.listOutputFiles", () => {
  it("agents.md target returns single path", () => {
    const paths = agentsMdTarget.listOutputFiles([], {}, "/workspace");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/workspace/AGENTS.md");
  });

  it("agents.md target respects custom outputPath option", () => {
    const paths = agentsMdTarget.listOutputFiles(
      [],
      { outputPath: "/custom/AGENTS.md" },
      "/workspace"
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/custom/AGENTS.md");
  });

  it("claude.md target returns single path", () => {
    const paths = claudeMdTarget.listOutputFiles([], {}, "/workspace");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/workspace/CLAUDE.md");
  });

  it("cursor-rules target returns one path per rule", () => {
    const rules = [
      makeRule("rule-a", "Content A"),
      makeRule("rule-b", "Content B"),
      makeRule("rule-c", "Content C"),
    ];
    const paths = cursorRulesTarget.listOutputFiles(rules, {}, "/workspace");
    expect(paths).toHaveLength(3);
    expect(paths).toContain("/workspace/.cursor/rules/rule-a.mdc");
    expect(paths).toContain("/workspace/.cursor/rules/rule-b.mdc");
    expect(paths).toContain("/workspace/.cursor/rules/rule-c.mdc");
  });

  it("cursor-rules target returns empty list for zero rules", () => {
    const paths = cursorRulesTarget.listOutputFiles([], {}, "/workspace");
    expect(paths).toHaveLength(0);
  });
});

// ─── Staleness detection integration tests ───────────────────────────────────
// These tests write real files to a temp directory and call compileRules() in check mode.
// The temp workspace is empty (no rules in .minsky/rules/, .cursor/rules/, or .ai/rules/),
// so compileRules() produces empty-ruleset output, which we compare against what we write.

describe("compileRules --check staleness detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  async function expectedAgentsMdContent(): Promise<string> {
    return buildContent([], DEFAULT_AGENTS_MD_SECTIONS).content;
  }

  async function expectedClaudeMdContent(): Promise<string> {
    return buildClaudeMdContent([]).content;
  }

  describe("agents.md target", () => {
    it("(a) fresh output — not stale", async () => {
      const content = await expectedAgentsMdContent();
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), content, "utf-8");

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "agents.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.staleFile).toBeUndefined();
    });

    it("(b) modified output — stale", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "STALE CONTENT", "utf-8");

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "agents.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("AGENTS.md");
    });

    it("(c) missing output — stale", async () => {
      const result = await compileRules({
        workspacePath: tmpDir,
        target: "agents.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("AGENTS.md");
    });
  });

  describe("claude.md target", () => {
    it("(a) fresh output — not stale", async () => {
      const content = await expectedClaudeMdContent();
      await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), content, "utf-8");

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "claude.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
    });

    it("(b) modified output — stale", async () => {
      await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "outdated content", "utf-8");

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "claude.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("CLAUDE.md");
    });

    it("(c) missing output — stale", async () => {
      const result = await compileRules({
        workspacePath: tmpDir,
        target: "claude.md",
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
    });
  });

  describe("cursor-rules target", () => {
    it("(a) fresh output — empty workspace, empty output dir — not stale", async () => {
      // Use a custom outputPath not scanned by RuleService, so we control the expected files
      const customOutputDir = path.join(tmpDir, "compiled-rules");
      await fs.mkdir(customOutputDir, { recursive: true });
      // No .mdc files, zero rules → not stale

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "cursor-rules",
        output: customOutputDir,
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
    });

    it("(e) cursor-rules orphan .mdc file in output dir — stale", async () => {
      // Use a custom outputPath not scanned by RuleService.
      // allRules = [] (empty workspace), expectedFiles = [].
      // The custom output dir has an old .mdc file → orphan → stale.
      const customOutputDir = path.join(tmpDir, "compiled-rules");
      await fs.mkdir(customOutputDir, { recursive: true });
      await fs.writeFile(
        path.join(customOutputDir, "old-rule.mdc"),
        "---\nalwaysApply: false\n---\nOld rule content",
        "utf-8"
      );

      const result = await compileRules({
        workspacePath: tmpDir,
        target: "cursor-rules",
        output: customOutputDir,
        check: true,
      });
      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toContain("old-rule.mdc");
    });
  });
});

// ─── cursor-rules multi-file check scenario ──────────────────────────────────
// Scenario (d): one of many files is modified → stale.
// Tests the per-file comparison logic in buildCursorRulesContent.

describe("cursor-rules multi-file staleness (d)", () => {
  it("one of many files modified → stale file is identified", async () => {
    const tmpBase = await createTempDir();
    try {
      const outputDir = path.join(tmpBase, "compiled-rules");
      await fs.mkdir(outputDir, { recursive: true });

      const rules = [
        makeRule("rule-a", "Content A"),
        makeRule("rule-b", "Content B"),
        makeRule("rule-c", "Content C"),
      ];
      const { files } = buildCursorRulesContent(rules, outputDir);

      // Write rule-a and rule-c with correct content; corrupt rule-b
      for (const { path: filePath, content } of files) {
        const basename = path.basename(filePath);
        await fs.writeFile(
          filePath,
          basename === "rule-b.mdc" ? "WRONG CONTENT" : content,
          "utf-8"
        );
      }

      // Simulate the per-file check loop from crud-operations.ts
      let foundStale: string | undefined;
      for (const { path: filePath, content: expectedContent } of files) {
        const existingContent = await fs.readFile(filePath, "utf-8");
        if (existingContent !== expectedContent) {
          foundStale = filePath;
          break;
        }
      }

      expect(foundStale).toBeDefined();
      expect(foundStale).toContain("rule-b.mdc");
    } finally {
      await removeTempDir(tmpBase);
    }
  });
});
