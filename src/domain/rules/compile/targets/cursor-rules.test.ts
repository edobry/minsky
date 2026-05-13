import { describe, it, expect } from "bun:test";
import { cursorRulesTarget, buildCursorRulesContent, serializeRuleToMdc } from "./cursor-rules";
import type { Rule } from "../../types";
import { SOME_RULE_CONTENT } from "./test-fixtures";
import { makeRule } from "../test-utils";
import { first } from "../../../../utils/array-safety";

describe("cursor-rules target", () => {
  describe("target metadata", () => {
    it("has id 'cursor-rules'", () => {
      expect(cursorRulesTarget.id).toBe("cursor-rules");
    });

    it("has the correct displayName", () => {
      expect(cursorRulesTarget.displayName).toBe("Cursor Rules (.cursor/rules/)");
    });

    it("defaultOutputPath returns .cursor/rules/ under workspace", () => {
      const result = cursorRulesTarget.defaultOutputPath("/workspace");
      expect(result).toBe("/workspace/.cursor/rules");
    });
  });

  describe("listOutputFiles()", () => {
    it("returns one path per rule", () => {
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

    it("returns empty list for zero rules", () => {
      const paths = cursorRulesTarget.listOutputFiles([], {}, "/workspace");
      expect(paths).toHaveLength(0);
    });
  });

  describe("serializeRuleToMdc()", () => {
    it("produces valid .mdc with YAML frontmatter delimiters", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT);
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("---\n");
      expect(mdc.startsWith("---\n")).toBe(true);
    });

    it("includes rule content after frontmatter", () => {
      const rule = makeRule("test-rule", SOME_RULE_CONTENT);
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain(SOME_RULE_CONTENT);
    });

    it("preserves name in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", { name: "My Rule Name" });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("name:");
      expect(mdc).toContain("My Rule Name");
    });

    it("preserves description in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", {
        description: "A description of the rule",
      });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("description:");
      expect(mdc).toContain("A description of the rule");
    });

    it("preserves globs in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", { globs: ["**/*.ts", "**/*.tsx"] });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("globs:");
      expect(mdc).toContain("**/*.ts");
      expect(mdc).toContain("**/*.tsx");
    });

    it("preserves alwaysApply: true in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", { alwaysApply: true });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("alwaysApply:");
      expect(mdc).toContain("true");
    });

    it("preserves alwaysApply: false in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", { alwaysApply: false });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("alwaysApply:");
      expect(mdc).toContain("false");
    });

    it("preserves tags in frontmatter", () => {
      const rule = makeRule("test-rule", "Content", { tags: ["alpha", "beta"] });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("tags:");
      expect(mdc).toContain("alpha");
      expect(mdc).toContain("beta");
    });

    it("produces valid .mdc for a rule with no optional frontmatter fields", () => {
      const rule: Rule = {
        id: "bare-rule",
        content: "Bare content",
        format: "cursor",
        path: "/fake/bare-rule.mdc",
      };
      const mdc = serializeRuleToMdc(rule);
      // Should still have frontmatter delimiters
      expect(mdc).toContain("---\n");
      // Content should be present
      expect(mdc).toContain("Bare content");
    });

    it("preserves all frontmatter fields together", () => {
      const rule = makeRule("full-rule", "Full content", {
        name: "Full Rule",
        description: "A complete rule",
        globs: ["**/*.ts"],
        alwaysApply: true,
        tags: ["important"],
      });
      const mdc = serializeRuleToMdc(rule);
      expect(mdc).toContain("name:");
      expect(mdc).toContain("description:");
      expect(mdc).toContain("globs:");
      expect(mdc).toContain("alwaysApply:");
      expect(mdc).toContain("tags:");
      expect(mdc).toContain("Full content");
    });

    // mt#1798: generated-file banner is emitted as a YAML comment inside the
    // frontmatter block. The banner must be on line 2 (line 1 is the `---`
    // opener; Cursor's parser is strict about that). The banner string is
    // matched by the `check-generated-file-edit` hook's existing
    // `# Generated by` regex so direct edits to .cursor/rules/*.mdc files are
    // blocked.
    describe("generated-file banner (mt#1798)", () => {
      it("emits the banner as the second line of the file", () => {
        const rule = makeRule("test-rule", "Content");
        const mdc = serializeRuleToMdc(rule);
        const lines = mdc.split("\n");
        expect(lines[0]).toBe("---");
        expect(lines[1]).toBe("# Generated by minsky rules compile. Do not edit directly.");
      });

      it("banner is preserved when frontmatter is empty", () => {
        const rule: Rule = {
          id: "bare-rule",
          content: "Bare content",
          format: "cursor",
          path: "/fake/bare-rule.mdc",
        };
        const mdc = serializeRuleToMdc(rule);
        expect(mdc.split("\n")[1]).toBe(
          "# Generated by minsky rules compile. Do not edit directly."
        );
      });

      it("banner matches the hook's `# Generated by` regex", () => {
        // The hook in .claude/hooks/check-generated-file-edit.ts reads the
        // first 5 lines and matches `^\s*#\s*Generated by\b` (case-insensitive,
        // multiline). Regression guard: if either side drifts, this fails.
        const rule = makeRule("test-rule", "Content");
        const mdc = serializeRuleToMdc(rule);
        const firstFiveLines = mdc.split("\n").slice(0, 5).join("\n");
        expect(firstFiveLines).toMatch(/^\s*#\s*Generated by\b/im);
      });
    });
  });

  describe("buildCursorRulesContent()", () => {
    it("returns one file per rule", () => {
      const rules = [
        makeRule("rule-a", "Content A"),
        makeRule("rule-b", "Content B"),
        makeRule("rule-c", "Content C"),
      ];
      const { files } = buildCursorRulesContent(rules, "/output/dir");
      expect(files).toHaveLength(3);
    });

    it("each file path is in the output directory with .mdc extension", () => {
      const rules = [makeRule("my-rule", "Content")];
      const { files } = buildCursorRulesContent(rules, "/output/dir");
      expect(first(files).path).toBe("/output/dir/my-rule.mdc");
    });

    it("file content is the serialized .mdc for the rule", () => {
      const rules = [makeRule("test-rule", "Rule body text", { name: "Test Rule" })];
      const { files } = buildCursorRulesContent(rules, "/output");
      const file = first(files);
      expect(file.content).toContain("name:");
      expect(file.content).toContain("Test Rule");
      expect(file.content).toContain("Rule body text");
    });

    it("all rules are included in rulesIncluded", () => {
      const rules = [makeRule("rule-one", "Content one"), makeRule("rule-two", "Content two")];
      const { rulesIncluded } = buildCursorRulesContent(rules, "/output");
      expect(rulesIncluded).toContain("rule-one");
      expect(rulesIncluded).toContain("rule-two");
    });

    it("rulesSkipped is empty (all rules are included)", () => {
      const rules = [makeRule("rule-a", "Content"), makeRule("rule-b", "Content")];
      const { rulesSkipped } = buildCursorRulesContent(rules, "/output");
      expect(rulesSkipped).toHaveLength(0);
    });

    it("returns empty files and rulesIncluded for empty input", () => {
      const { files, rulesIncluded, rulesSkipped } = buildCursorRulesContent([], "/output");
      expect(files).toHaveLength(0);
      expect(rulesIncluded).toHaveLength(0);
      expect(rulesSkipped).toHaveLength(0);
    });

    it("uses the rule id as the filename (not the path or name)", () => {
      const rule = makeRule("my-rule-id", "Content", { name: "Some Other Name" });
      const { files } = buildCursorRulesContent([rule], "/output");
      const file = first(files);
      expect(file.path).toContain("my-rule-id.mdc");
      expect(file.path).not.toContain("Some Other Name");
    });
  });
});
