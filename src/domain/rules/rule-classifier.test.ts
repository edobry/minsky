import { describe, it, expect } from "bun:test";
import type { Rule } from "./types";

// TODO: This function should be implemented in rule-classifier.ts
import { classifyRuleType, classifyRuleTypeWithWarnings, RuleType } from "./rule-classifier";

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

    it("should prioritize alwaysApply over globs (priority order test)", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        alwaysApply: true,
        globs: ["**/*.ts"],
        description: "Has all properties",
        content: "Priority test"
      };
      
      // Priority 1: alwaysApply takes precedence over everything
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.ALWAYS_APPLY);
    });

    it("should prioritize globs over description when both present (priority order test)", () => {
      const rule: Partial<Rule> = {
        id: "test-rule",
        globs: ["**/*.ts"],
        description: "TypeScript rules",
        content: "TS content"
      };
      
      // Priority 2: globs takes precedence over description
      expect(classifyRuleType(rule as Rule)).toBe(RuleType.AUTO_ATTACHED);
    });

    it("should follow complete priority order: alwaysApply > globs > description > manual", () => {
      // Test all combinations to verify priority hierarchy
      
      // Has all properties - alwaysApply wins (Priority 1)
      const allPropsRule: Partial<Rule> = {
        id: "all-props",
        alwaysApply: true,
        globs: ["**/*.ts"],
        description: "Has everything",
        content: "All properties"
      };
      expect(classifyRuleType(allPropsRule as Rule)).toBe(RuleType.ALWAYS_APPLY);
      
      // No alwaysApply, has globs + description - globs wins (Priority 2)
      const globsDescRule: Partial<Rule> = {
        id: "globs-desc",
        globs: ["**/*.tsx"],
        description: "React components",
        content: "Globs and description"
      };
      expect(classifyRuleType(globsDescRule as Rule)).toBe(RuleType.AUTO_ATTACHED);
      
      // Only description - agent requested (Priority 3)  
      const descOnlyRule: Partial<Rule> = {
        id: "desc-only",
        description: "Agent can decide",
        content: "Description only"
      };
      expect(classifyRuleType(descOnlyRule as Rule)).toBe(RuleType.AGENT_REQUESTED);
      
      // No special properties - manual (Priority 4)
      const manualRule: Partial<Rule> = {
        id: "manual-rule",
        content: "No special properties"
      };
      expect(classifyRuleType(manualRule as Rule)).toBe(RuleType.MANUAL);
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

  describe("classifyRuleTypeWithWarnings", () => {
    it("should warn when rule has multiple classification properties", () => {
      const rule: Partial<Rule> = {
        id: "multi-prop-rule",
        alwaysApply: true,
        globs: ["**/*.ts"],
        description: "Has multiple properties",
        content: "Test content"
      };

      const result = classifyRuleTypeWithWarnings(rule as Rule);
      
      expect(result.type).toBe(RuleType.ALWAYS_APPLY);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("multiple classification properties");
      expect(result.warnings![0]).toContain("[alwaysApply, globs, description]");
      expect(result.warnings![0]).toContain("Current priority: alwaysApply");
    });

    it("should warn when globs and description are both present", () => {
      const rule: Partial<Rule> = {
        id: "globs-desc-rule", 
        globs: ["**/*.tsx"],
        description: "React rules",
        content: "Test content"
      };

      const result = classifyRuleTypeWithWarnings(rule as Rule);
      
      expect(result.type).toBe(RuleType.AUTO_ATTACHED);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("[globs, description]");
      expect(result.warnings![0]).toContain("Current priority: globs");
    });

    it("should not warn for rules with single classification property", () => {
      const alwaysApplyRule: Partial<Rule> = {
        id: "always-rule",
        alwaysApply: true,
        content: "Always apply"
      };

      const globsRule: Partial<Rule> = {
        id: "globs-rule",
        globs: ["**/*.ts"],
        content: "Auto attached"
      };

      const descRule: Partial<Rule> = {
        id: "desc-rule",
        description: "Agent requested",
        content: "Agent decides"
      };

      const manualRule: Partial<Rule> = {
        id: "manual-rule",
        content: "Manual only"
      };

      expect(classifyRuleTypeWithWarnings(alwaysApplyRule as Rule).warnings).toBeUndefined();
      expect(classifyRuleTypeWithWarnings(globsRule as Rule).warnings).toBeUndefined();
      expect(classifyRuleTypeWithWarnings(descRule as Rule).warnings).toBeUndefined();
      expect(classifyRuleTypeWithWarnings(manualRule as Rule).warnings).toBeUndefined();
    });

    it("should handle edge case of alwaysApply false with other properties", () => {
      const rule: Partial<Rule> = {
        id: "false-always-rule",
        alwaysApply: false,
        globs: ["**/*.ts"],
        description: "Has globs and desc",
        content: "Test content"
      };

      const result = classifyRuleTypeWithWarnings(rule as Rule);
      
      // alwaysApply: false doesn't count as classification property
      expect(result.type).toBe(RuleType.AUTO_ATTACHED);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("[globs, description]");
    });
  });
});
