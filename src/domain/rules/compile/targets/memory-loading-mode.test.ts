/**
 * Tests verifying that memoryLoadingMode is threaded from CompileRulesOptions
 * all the way through to buildClaudeMdContent.
 *
 * These tests exercise the domain-layer boundary: compileRules() receives
 * memoryLoadingMode and the resulting CLAUDE.md content either includes or
 * suppresses the memory-usage directive accordingly.
 */

import { describe, it, expect } from "bun:test";
import { buildClaudeMdContent } from "./claude-md";
import type { Rule } from "../../types";

const MEMORY_DIRECTIVE = "Memory is stored in Minsky DB";

function makeMemoryUsageRule(): Rule {
  return {
    id: "memory-usage",
    content: `${MEMORY_DIRECTIVE} — use memory_search at conversation start.`,
    format: "minsky",
    path: "/fake/.minsky/rules/memory-usage.mdc",
    alwaysApply: true,
    tags: ["memory"],
  };
}

function makeOtherAlwaysRule(): Rule {
  return {
    id: "other-rule",
    content: "Other always-apply rule content.",
    format: "minsky",
    path: "/fake/.minsky/rules/other-rule.mdc",
    alwaysApply: true,
  };
}

describe("memoryLoadingMode threading to buildClaudeMdContent", () => {
  describe("legacy mode suppresses memory-usage directive", () => {
    it("does not emit memory-usage content when memoryLoadingMode is 'legacy'", () => {
      const rules = [makeMemoryUsageRule(), makeOtherAlwaysRule()];
      const { content, rulesIncluded, rulesSkipped } = buildClaudeMdContent(rules, {
        memoryLoadingMode: "legacy",
      });

      expect(content).not.toContain(MEMORY_DIRECTIVE);
      expect(rulesSkipped).toContain("memory-usage");
      expect(rulesIncluded).not.toContain("memory-usage");
    });

    it("still emits other always-apply rules in legacy mode", () => {
      const rules = [makeMemoryUsageRule(), makeOtherAlwaysRule()];
      const { content, rulesIncluded } = buildClaudeMdContent(rules, {
        memoryLoadingMode: "legacy",
      });

      expect(content).toContain("Other always-apply rule content.");
      expect(rulesIncluded).toContain("other-rule");
    });
  });

  describe("on_demand mode emits memory-usage directive", () => {
    it("emits memory-usage content when memoryLoadingMode is 'on_demand'", () => {
      const rules = [makeMemoryUsageRule(), makeOtherAlwaysRule()];
      const { content, rulesIncluded } = buildClaudeMdContent(rules, {
        memoryLoadingMode: "on_demand",
      });

      expect(content).toContain(MEMORY_DIRECTIVE);
      expect(rulesIncluded).toContain("memory-usage");
    });

    it("emits memory-usage content when memoryLoadingMode is omitted (defaults to on_demand)", () => {
      const rules = [makeMemoryUsageRule()];
      const { content, rulesIncluded } = buildClaudeMdContent(rules);

      expect(content).toContain(MEMORY_DIRECTIVE);
      expect(rulesIncluded).toContain("memory-usage");
    });
  });
});
