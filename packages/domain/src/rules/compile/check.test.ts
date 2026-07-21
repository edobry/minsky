/**
 * Tests for `rules compile --check` staleness detection.
 *
 * Covers:
 *   (a) fresh output not stale
 *   (b) modified output stale
 *   (c) missing output stale
 *
 * The legacy `cursor-rules` target's multi-file / orphan-.mdc check-mode
 * cases were removed in mt#2995 — that target was retired (unregistered
 * from `createCompileService()`); `.cursor/rules/` is now written solely by
 * `cursor-rules-ts` (packages/domain/src/compile/targets/cursor-rules-ts.ts),
 * which has its own test coverage.
 *
 * Uses in-memory fs (createMockFs) injected via compileRules' `deps` seam.
 */

import { describe, it, expect } from "bun:test";
import { compileRules } from "../operations/crud-operations";
import { RuleService } from "../rule-service";
import { createMockFs } from "../../interfaces/mock-fs";
import { buildContent, DEFAULT_AGENTS_MD_SECTIONS } from "./targets/agents-md";
import { buildClaudeMdContent } from "./targets/claude-md";
import { serializeRuleToMdc } from "./targets/cursor-rules";
import { makeRule } from "./test-utils";

const WORKSPACE = "/mock/workspace";

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
});

// ─── size budget (mt#2802) ──────────────────────────────────────────────────
// The `--check` path evaluates the size budget via the same dry-run compile
// used for staleness detection (compileDryRun in compile-service.ts). These
// tests exercise that end-to-end wiring through the public `compileRules`
// entry point — the same function the `rules.compile` CLI command calls.

describe("compileRules --check size budget (mt#2802)", () => {
  describe("agents.md target", () => {
    it("reports sizeChars and status 'ok' for small, on-budget content", async () => {
      const expected = buildContent([], DEFAULT_AGENTS_MD_SECTIONS).content;
      const { fs, ruleService } = setupMockFs({ [`${WORKSPACE}/AGENTS.md`]: expected });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "agents.md", check: true },
        { fs, ruleService }
      );

      expect(result.stale).toBe(false);
      expect(result.sizeChars).toBe(expected.length);
      expect(result.sizeBudgetStatus).toBe("ok");
      expect(result.sizeBudget).toEqual({ warnChars: 160_000, failChars: 200_000 });
      expect(result.topContributors).toEqual([]);
    });

    it("classifies status 'fail' and names top contributors when an override threshold is exceeded", async () => {
      const rules = [
        makeRule("big-rule", "x".repeat(500), { alwaysApply: true }),
        makeRule("small-rule", "y".repeat(50), { alwaysApply: true }),
      ];
      const sourceDir = `${WORKSPACE}/.cursor/rules`;
      const initialFiles: Record<string, string> = {};
      for (const rule of rules) {
        initialFiles[`${sourceDir}/${rule.id}.mdc`] = serializeRuleToMdc(rule);
      }
      const expected = buildContent(rules, DEFAULT_AGENTS_MD_SECTIONS).content;
      initialFiles[`${WORKSPACE}/AGENTS.md`] = expected;

      const { fs, ruleService } = setupMockFs(initialFiles);

      const result = await compileRules(
        {
          workspacePath: WORKSPACE,
          target: "agents.md",
          check: true,
          sizeBudget: { warnChars: 100, failChars: 400 },
        },
        { fs, ruleService }
      );

      expect(result.stale).toBe(false);
      expect(result.sizeBudgetStatus).toBe("fail");
      expect(result.sizeBudget).toEqual({ warnChars: 100, failChars: 400 });
      expect(result.topContributors?.[0]).toEqual({ id: "big-rule", size: 500 });
      expect(result.topContributors?.[1]).toEqual({ id: "small-rule", size: 50 });
    });
  });

  describe("claude.md target", () => {
    it("reports sizeChars and status 'ok' for small, on-budget content", async () => {
      const expected = buildClaudeMdContent([]).content;
      const { fs, ruleService } = setupMockFs({ [`${WORKSPACE}/CLAUDE.md`]: expected });

      const result = await compileRules(
        { workspacePath: WORKSPACE, target: "claude.md", check: true },
        { fs, ruleService }
      );

      expect(result.stale).toBe(false);
      expect(result.sizeChars).toBe(expected.length);
      expect(result.sizeBudgetStatus).toBe("ok");
      expect(result.sizeBudget).toEqual({ warnChars: 115_000, failChars: 140_000 });
    });

    it("classifies status 'warn' when between warnChars and failChars (override)", async () => {
      const midRule = makeRule("mid-rule", "z".repeat(300), { alwaysApply: true });
      const rules = [midRule];
      const sourceDir = `${WORKSPACE}/.cursor/rules`;
      const initialFiles: Record<string, string> = {
        [`${sourceDir}/mid-rule.mdc`]: serializeRuleToMdc(midRule),
      };
      const expected = buildClaudeMdContent(rules).content;
      initialFiles[`${WORKSPACE}/CLAUDE.md`] = expected;

      const { fs, ruleService } = setupMockFs(initialFiles);

      const result = await compileRules(
        {
          workspacePath: WORKSPACE,
          target: "claude.md",
          check: true,
          sizeBudget: { warnChars: 200, failChars: 1000 },
        },
        { fs, ruleService }
      );

      expect(result.stale).toBe(false);
      expect(result.sizeBudgetStatus).toBe("warn");
      expect(result.topContributors?.[0]?.id).toBe("mid-rule");
    });
  });
});
