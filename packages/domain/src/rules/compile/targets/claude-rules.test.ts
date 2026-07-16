/* eslint-disable custom/no-real-fs-in-tests -- claude-rules.ts (like its
 * cursor-rules.ts / agents-md.ts / claude-md.ts siblings) hardcodes
 * `import * as fs from "fs/promises"` internally with no injectable fs seam
 * for the WRITE path. The compile()/stale-removal tests below exercise that
 * real write+unlink behavior directly, so they need a real scratch
 * directory; mkdtemp() under the OS tmpdir + afterEach cleanup follows the
 * same pattern established in
 * packages/domain/src/rules/operations/crud-operations.test.ts, which
 * documents the identical constraint for the sibling legacy targets. */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  claudeRulesTarget,
  buildClaudeRulesContent,
  serializeRuleToClaudeRule,
  isEligibleForClaudeRules,
  sanitizeGlobForClaudeRules,
  CLAUDE_RULES_BANNER,
} from "./claude-rules";
import type { Rule } from "../../types";
import { SOME_RULE_CONTENT } from "./test-fixtures";
import { makeRule } from "../test-utils";
import { first } from "@minsky/shared/array-safety";

// mt#2868: scratch dirs for real-fs compile()/stale-removal tests, mirroring
// the mkdtemp() + afterEach cleanup pattern established in
// packages/domain/src/rules/operations/crud-operations.test.ts.
const scratchDirs: string[] = [];
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mt2868-claude-rules-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("claude-rules target", () => {
  describe("target metadata", () => {
    it("has id 'claude-rules'", () => {
      expect(claudeRulesTarget.id).toBe("claude-rules");
    });

    it("has the correct displayName", () => {
      expect(claudeRulesTarget.displayName).toBe("Claude Rules (.claude/rules/)");
    });

    it("defaultOutputPath returns .claude/rules/ under workspace", () => {
      const result = claudeRulesTarget.defaultOutputPath("/workspace");
      expect(result).toBe("/workspace/.claude/rules");
    });
  });

  describe("isEligibleForClaudeRules() — hard-constraint eligibility predicate", () => {
    it("excludes a rule with no globs at all", () => {
      const rule = makeRule("no-globs", SOME_RULE_CONTENT, { alwaysApply: false });
      expect(isEligibleForClaudeRules(rule)).toBe(false);
    });

    it("excludes a rule with an empty globs array", () => {
      const rule = makeRule("empty-globs", SOME_RULE_CONTENT, { globs: [], alwaysApply: false });
      expect(isEligibleForClaudeRules(rule)).toBe(false);
    });

    it("excludes a rule with alwaysApply: true even if it has globs (never emit always-apply rules)", () => {
      const rule = makeRule("always-with-globs", SOME_RULE_CONTENT, {
        globs: ["**/*.ts"],
        alwaysApply: true,
      });
      expect(isEligibleForClaudeRules(rule)).toBe(false);
    });

    it("excludes a rule with globs but alwaysApply left undefined (not explicitly false)", () => {
      // Rules that never declared a classification either way stay excluded
      // rather than being inferred into eligibility (design decision 1).
      const rule: Rule = {
        id: "undefined-always-apply",
        content: SOME_RULE_CONTENT,
        format: "cursor",
        path: "/fake/undefined-always-apply.mdc",
        globs: ["**/*"],
      };
      expect(isEligibleForClaudeRules(rule)).toBe(false);
    });

    it("includes a rule with non-empty globs and alwaysApply: false", () => {
      const rule = makeRule("eligible-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.test.ts"],
        alwaysApply: false,
      });
      expect(isEligibleForClaudeRules(rule)).toBe(true);
    });
  });

  describe("sanitizeGlobForClaudeRules() — bracket escaping (design decision 4)", () => {
    it("escapes a literal '[' as '\\['", () => {
      expect(sanitizeGlobForClaudeRules("src/foo[bar].ts")).toBe("src/foo\\[bar].ts");
    });

    it("escapes multiple literal '[' occurrences", () => {
      expect(sanitizeGlobForClaudeRules("[a][b].ts")).toBe("\\[a]\\[b].ts");
    });

    it("leaves a bracket-free glob unchanged", () => {
      expect(sanitizeGlobForClaudeRules("**/*.test.ts")).toBe("**/*.test.ts");
    });

    it("leaves ']' unescaped (only '[' is escaped per verified vendor-doc behavior)", () => {
      expect(sanitizeGlobForClaudeRules("foo]bar")).toBe("foo]bar");
    });
  });

  describe("serializeRuleToClaudeRule() — frontmatter + banner emission", () => {
    it("emits paths: frontmatter in flow-sequence style", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.test.ts"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      const lines = md.split("\n");
      expect(lines[0]).toBe("---");
      expect(lines[1]).toBe("paths: ['**/*.test.ts']");
      expect(lines[2]).toBe("---");
    });

    it("emits multiple globs as a single flow-sequence line", () => {
      const rule = makeRule("multi-glob-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.test.ts", "tests/**"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      const lines = md.split("\n");
      expect(lines[1]).toBe("paths: ['**/*.test.ts', 'tests/**']");
    });

    it("emits the generation banner as the FIRST line of the body, right after the closing '---' (design decision 3)", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.ts"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      const lines = md.split("\n");
      expect(lines[2]).toBe("---");
      expect(lines[3]).toBe(CLAUDE_RULES_BANNER);
    });

    it("does NOT emit the banner as a frontmatter field", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.ts"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      const frontmatterBlock = md.split("---")[1];
      expect(frontmatterBlock).not.toContain("Generated by");
    });

    it("keeps the frontmatter block within the 5-line generated-file-edit-guard scan window regardless of glob count", () => {
      const rule = makeRule("many-globs-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "src/**/*.md"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      const firstFiveLines = md.split("\n").slice(0, 5).join("\n");
      expect(firstFiveLines).toContain(CLAUDE_RULES_BANNER);
    });

    it("includes rule content after the banner", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT, {
        globs: ["**/*.ts"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      expect(md).toContain(SOME_RULE_CONTENT);
    });

    it("escapes a bracket-containing glob in the emitted frontmatter", () => {
      const rule = makeRule("bracket-glob-rule", SOME_RULE_CONTENT, {
        globs: ["src/foo[bar]/**"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      expect(md).toContain("foo\\[bar]");
      expect(md).not.toContain("'src/foo[bar]/**'");
    });

    it("YAML-escapes a literal single quote inside a glob", () => {
      const rule = makeRule("quote-glob-rule", SOME_RULE_CONTENT, {
        globs: ["src/it's-a-dir/**"],
        alwaysApply: false,
      });
      const md = serializeRuleToClaudeRule(rule);
      expect(md).toContain("it''s-a-dir");
    });
  });

  describe("buildClaudeRulesContent() — eligibility filtering", () => {
    it("includes only eligible rules in the file list", () => {
      const rules = [
        makeRule("eligible", "Content A", { globs: ["**/*.ts"], alwaysApply: false }),
        makeRule("no-globs", "Content B", { alwaysApply: false }),
        makeRule("always-apply", "Content C", { globs: ["**/*.ts"], alwaysApply: true }),
      ];
      const { files, rulesIncluded, rulesSkipped } = buildClaudeRulesContent(rules, "/output");
      expect(files).toHaveLength(1);
      expect(first(files).path).toBe("/output/eligible.md");
      expect(rulesIncluded).toEqual(["eligible"]);
      expect(rulesSkipped).toEqual(["no-globs", "always-apply"]);
    });

    it("uses the rule id as the filename with a .md extension (not .mdc)", () => {
      const rule = makeRule("my-rule-id", "Content", { globs: ["**/*.ts"], alwaysApply: false });
      const { files } = buildClaudeRulesContent([rule], "/output");
      expect(first(files).path).toBe("/output/my-rule-id.md");
    });

    it("returns empty files and rulesSkipped for empty input", () => {
      const { files, rulesIncluded, rulesSkipped } = buildClaudeRulesContent([], "/output");
      expect(files).toHaveLength(0);
      expect(rulesIncluded).toHaveLength(0);
      expect(rulesSkipped).toHaveLength(0);
    });

    it("skips ALL rules when none are eligible (never emits a glob-less file)", () => {
      const rules = [
        makeRule("a", "A", { alwaysApply: true }),
        makeRule("b", "B", { alwaysApply: false }),
        makeRule("c", "C", { globs: [], alwaysApply: false }),
      ];
      const { files, rulesSkipped } = buildClaudeRulesContent(rules, "/output");
      expect(files).toHaveLength(0);
      expect(rulesSkipped).toEqual(["a", "b", "c"]);
    });
  });

  describe("listOutputFiles()", () => {
    it("returns paths only for eligible rules", () => {
      const rules = [
        makeRule("eligible-a", "A", { globs: ["**/*.ts"], alwaysApply: false }),
        makeRule("ineligible-b", "B", { alwaysApply: true }),
        makeRule("eligible-c", "C", { globs: ["tests/**"], alwaysApply: false }),
      ];
      const paths = claudeRulesTarget.listOutputFiles(rules, {}, "/workspace");
      expect(paths).toHaveLength(2);
      expect(paths).toContain("/workspace/.claude/rules/eligible-a.md");
      expect(paths).toContain("/workspace/.claude/rules/eligible-c.md");
      expect(paths).not.toContain("/workspace/.claude/rules/ineligible-b.md");
    });

    it("returns empty list when no rules are eligible", () => {
      const rules = [makeRule("always", "A", { alwaysApply: true })];
      const paths = claudeRulesTarget.listOutputFiles(rules, {}, "/workspace");
      expect(paths).toHaveLength(0);
    });
  });

  describe("compile() — real-fs write + stale-file removal", () => {
    it("writes a file only for the eligible rule", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");
      const rules = [
        makeRule("eligible", "Eligible content", { globs: ["**/*.ts"], alwaysApply: false }),
        makeRule("ineligible", "Ineligible content", { alwaysApply: false }),
      ];
      const result = await claudeRulesTarget.compile(rules, { outputPath: outputDir }, dir);
      expect(result.filesWritten).toEqual([join(outputDir, "eligible.md")]);
      const written = await readFile(join(outputDir, "eligible.md"), "utf-8");
      expect(written).toContain("paths: ['**/*.ts']");
      expect(written).toContain("Eligible content");
    });

    it("removes a previously-generated file whose rule lost its globs (stale removal)", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");

      // First compile: rule is eligible, file gets written.
      const eligibleRule = makeRule("shrinking-rule", "Content", {
        globs: ["**/*.ts"],
        alwaysApply: false,
      });
      await claudeRulesTarget.compile([eligibleRule], { outputPath: outputDir }, dir);
      const staleFilePath = join(outputDir, "shrinking-rule.md");
      expect(await readFile(staleFilePath, "utf-8")).toContain("paths:");

      // Second compile: same rule now has no globs — it must be removed.
      const noLongerEligible = makeRule("shrinking-rule", "Content", { alwaysApply: false });
      const result = await claudeRulesTarget.compile(
        [noLongerEligible],
        { outputPath: outputDir },
        dir
      );
      expect(result.filesWritten).toHaveLength(0);
      await expect(readFile(staleFilePath, "utf-8")).rejects.toThrow();
    });

    it("removes a previously-generated file whose rule flipped to alwaysApply: true (stale removal)", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");

      await claudeRulesTarget.compile(
        [makeRule("flip-rule", "Content", { globs: ["**/*.ts"], alwaysApply: false })],
        { outputPath: outputDir },
        dir
      );
      const staleFilePath = join(outputDir, "flip-rule.md");
      expect(await readFile(staleFilePath, "utf-8")).toContain("paths:");

      await claudeRulesTarget.compile(
        [makeRule("flip-rule", "Content", { globs: ["**/*.ts"], alwaysApply: true })],
        { outputPath: outputDir },
        dir
      );
      await expect(readFile(staleFilePath, "utf-8")).rejects.toThrow();
    });

    it("removes a previously-generated file for a rule disabled via selection config (absent from the rules array on recompile)", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");

      await claudeRulesTarget.compile(
        [
          makeRule("kept-rule", "Content", { globs: ["**/*.ts"], alwaysApply: false }),
          makeRule("disabled-rule", "Content", { globs: ["**/*.ts"], alwaysApply: false }),
        ],
        { outputPath: outputDir },
        dir
      );
      const disabledFilePath = join(outputDir, "disabled-rule.md");
      expect(await readFile(disabledFilePath, "utf-8")).toContain("paths:");

      // Recompile with the disabled rule filtered out upstream by
      // resolveActiveRules (compile-service.ts), simulating the CompileService
      // passing a narrowed `rules` array.
      const result = await claudeRulesTarget.compile(
        [makeRule("kept-rule", "Content", { globs: ["**/*.ts"], alwaysApply: false })],
        { outputPath: outputDir },
        dir
      );
      expect(result.filesWritten).toEqual([join(outputDir, "kept-rule.md")]);
      await expect(readFile(disabledFilePath, "utf-8")).rejects.toThrow();
      // The still-active rule's file is untouched.
      expect(await readFile(join(outputDir, "kept-rule.md"), "utf-8")).toContain("paths:");
    });

    it("does NOT remove a non-generated file in the output directory (no banner present)", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");
      await claudeRulesTarget.compile(
        [makeRule("eligible", "Content", { globs: ["**/*.ts"], alwaysApply: false })],
        { outputPath: outputDir },
        dir
      );
      const userFilePath = join(outputDir, "user-authored.md");
      await writeFile(userFilePath, "# Hand-written notes, not generated\n", "utf-8");

      await claudeRulesTarget.compile(
        [makeRule("eligible", "Content", { globs: ["**/*.ts"], alwaysApply: false })],
        { outputPath: outputDir },
        dir
      );
      expect(await readFile(userFilePath, "utf-8")).toContain("Hand-written notes");
    });

    it("recompiling with an unchanged eligible rule set leaves the file present", async () => {
      const dir = await scratchDir();
      const outputDir = join(dir, ".claude", "rules");
      const rule = makeRule("stable-rule", "Content", { globs: ["**/*.ts"], alwaysApply: false });
      await claudeRulesTarget.compile([rule], { outputPath: outputDir }, dir);
      await claudeRulesTarget.compile([rule], { outputPath: outputDir }, dir);
      expect(await readFile(join(outputDir, "stable-rule.md"), "utf-8")).toContain("Content");
    });
  });
});
