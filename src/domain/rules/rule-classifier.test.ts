import { describe, it, expect } from "bun:test";
import type { Rule } from "./types";

// TODO: This function should be implemented in rule-classifier.ts
import { classifyRuleType, RuleType } from "./rule-classifier";

describe("Rule Type Classification", () => {
  describe("classifyRuleType", () => {
    it("should classify rule with alwaysApply: true as ALWAYS_APPLY", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        alwaysApply: true,
        content: "Always apply this rule"
      };
      
      // This test should fail until classifyRuleType is implemented
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.ALWAYS_APPLY);
    });

    it("should classify rule with globs as AUTO_ATTACHED", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        globs: ["**/*.ts", "src/**/*.tsx"],
        content: "Apply to TypeScript files"
      };
      
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AUTO_ATTACHED);
    });

    it("should classify rule with description (but no globs or alwaysApply) as AGENT_REQUESTED", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        description: "React component best practices",
        content: "Use functional components"
      };
      
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AGENT_REQUESTED);
    });

    it("should classify rule with no special properties as MANUAL", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        content: "Manual rule content"
      };
      
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.MANUAL);
    });

    it("should prioritize alwaysApply over globs", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        alwaysApply: true,
        globs: ["**/*.ts"],
        description: "Has all properties",
        content: "Priority test"
      };
      
      // alwaysApply takes precedence
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.ALWAYS_APPLY);
    });

    it("should prioritize globs over description when both present", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        globs: ["**/*.ts"],
        description: "TypeScript rules",
        content: "TS content"
      };
      
      // globs takes precedence over description
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AUTO_ATTACHED);
    });

    it("should handle alwaysApply: false as not always apply", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        alwaysApply: false,
        description: "Optional rule",
        content: "Content"
      };
      
      // alwaysApply: false means check other properties
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AGENT_REQUESTED);
    });

    it("should handle empty globs array as not auto-attached", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        globs: [],
        description: "Empty globs",
        content: "Content"
      };
      
      // Empty globs array doesn't count
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AGENT_REQUESTED);
    });

    it("should handle whitespace-only description as manual", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        description: "   ",
        content: "Content"
      };
      
      // Whitespace-only description doesn't count
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.MANUAL);
    });
  });
});
