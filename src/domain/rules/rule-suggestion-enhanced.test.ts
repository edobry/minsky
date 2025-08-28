import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { Rule } from "./types";
import { RuleType } from "./rule-classifier";

// TODO: This enhanced suggest function should be implemented
import { suggestRules, type RuleSuggestOptions } from "./rule-suggestion-enhanced";

describe("Enhanced Rule Suggestion with Type Awareness", () => {
  // Mock rules for testing
  const mockRules: Rule[] = [
    {
      id: "always-rule-1",
      name: "Always Apply Rule",
      alwaysApply: true,
      content: "This rule always applies",
      format: "cursor",
      path: ".cursor/rules/always-rule-1.mdc"
    },
    {
      id: "glob-rule-ts",
      name: "TypeScript Rules",
      globs: ["**/*.ts", "**/*.tsx"],
      description: "TypeScript best practices",
      content: "Use strict TypeScript",
      format: "cursor",
      path: ".cursor/rules/glob-rule-ts.mdc"
    },
    {
      id: "glob-rule-test",
      name: "Test File Rules",
      globs: ["**/*.test.ts", "**/*.spec.ts"],
      content: "Test file conventions",
      format: "cursor",
      path: ".cursor/rules/glob-rule-test.mdc"
    },
    {
      id: "agent-rule-react",
      name: "React Best Practices",
      description: "React component patterns and hooks usage",
      content: "Use functional components",
      format: "cursor",
      path: ".cursor/rules/agent-rule-react.mdc"
    },
    {
      id: "agent-rule-security",
      name: "Security Guidelines",
      description: "Security best practices for authentication and data handling",
      content: "Always validate inputs",
      format: "cursor",
      path: ".cursor/rules/agent-rule-security.mdc"
    },
    {
      id: "manual-rule-1",
      name: "Manual Only Rule",
      content: "This rule is only applied manually",
      format: "cursor",
      path: ".cursor/rules/manual-rule-1.mdc"
    }
  ];

  // Mock similarity search results
  const mockSimilarityResults = [
    { id: "agent-rule-react", score: 0.9 },
    { id: "agent-rule-security", score: 0.7 },
    { id: "glob-rule-ts", score: 0.3 }, // Should be filtered out - wrong type
  ];

  beforeEach(() => {
    // Reset mocks
    mock.restore();
  });

  describe("Rule Type Filtering", () => {
    it("should always include ALWAYS_APPLY rules", async () => {
      const options: RuleSuggestOptions = {
        // No query or files - should still get always-apply rules
      };

      const suggestions = await suggestRules(options, mockRules);
      
      const alwaysRules = suggestions.filter(r => r.id === "always-rule-1");
      expect(alwaysRules).toHaveLength(1);
      expect(alwaysRules[0].id).toBe("always-rule-1");
    });

    it("should include AUTO_ATTACHED rules when files match globs", async () => {
      const options: RuleSuggestOptions = {
        filesInContext: [
          "src/components/Button.tsx",
          "src/utils/helper.ts"
        ]
      };

      const suggestions = await suggestRules(options, mockRules);
      
      // Should include the TypeScript glob rule
      const tsRule = suggestions.find(r => r.id === "glob-rule-ts");
      expect(tsRule).toBeDefined();
      expect(tsRule?.name).toBe("TypeScript Rules");
      
      // Should NOT include the test glob rule (no test files in context)
      const testRule = suggestions.find(r => r.id === "glob-rule-test");
      expect(testRule).toBeUndefined();
    });

    it("should include AGENT_REQUESTED rules based on query similarity", async () => {
      // Mock the similarity service
      const mockSimilarityService = {
        searchByText: mock(() => Promise.resolve(mockSimilarityResults))
      };

      const options: RuleSuggestOptions = {
        query: "how to build React components with hooks",
        limit: 5
      };

      const suggestions = await suggestRules(options, mockRules, mockSimilarityService);
      
      // Should include React rule (high similarity)
      const reactRule = suggestions.find(r => r.id === "agent-rule-react");
      expect(reactRule).toBeDefined();
      
      // Should include Security rule (lower but acceptable similarity)
      const securityRule = suggestions.find(r => r.id === "agent-rule-security");
      expect(securityRule).toBeDefined();
      
      // Should NOT include the TypeScript glob rule (wrong type for similarity)
      const tsRule = suggestions.find(r => r.id === "glob-rule-ts");
      expect(tsRule?.id).not.toBe("glob-rule-ts");
    });

    it("should NOT include MANUAL rules by default", async () => {
      const options: RuleSuggestOptions = {
        query: "anything",
        filesInContext: ["any.file"]
      };

      const suggestions = await suggestRules(options, mockRules);
      
      const manualRule = suggestions.find(r => r.id === "manual-rule-1");
      expect(manualRule).toBeUndefined();
    });

    it("should include MANUAL rules when explicitly requested", async () => {
      const options: RuleSuggestOptions = {
        includeManual: true
      };

      const suggestions = await suggestRules(options, mockRules);
      
      const manualRule = suggestions.find(r => r.id === "manual-rule-1");
      expect(manualRule).toBeDefined();
      expect(manualRule?.name).toBe("Manual Only Rule");
    });
  });

  describe("Combined Scenarios", () => {
    it("should combine multiple rule types appropriately", async () => {
      const mockSimilarityService = {
        searchByText: mock(() => Promise.resolve(mockSimilarityResults))
      };

      const options: RuleSuggestOptions = {
        query: "React component development",
        filesInContext: [
          "src/components/Form.tsx",
          "src/components/Form.test.ts"
        ],
        limit: 10
      };

      const suggestions = await suggestRules(options, mockRules, mockSimilarityService);
      
      // Should include:
      // 1. Always-apply rule
      expect(suggestions.find(r => r.id === "always-rule-1")).toBeDefined();
      
      // 2. TypeScript glob rule (matches .tsx file)
      expect(suggestions.find(r => r.id === "glob-rule-ts")).toBeDefined();
      
      // 3. Test glob rule (matches .test.ts file)
      expect(suggestions.find(r => r.id === "glob-rule-test")).toBeDefined();
      
      // 4. React agent rule (similarity match)
      expect(suggestions.find(r => r.id === "agent-rule-react")).toBeDefined();
      
      // Should NOT include:
      // - Manual rule (not requested)
      expect(suggestions.find(r => r.id === "manual-rule-1")).toBeUndefined();
    });

    it("should remove duplicates when rules match multiple criteria", async () => {
      // Add a rule that has both globs and description
      const hybridRule: Rule = {
        id: "hybrid-rule",
        name: "Hybrid Rule",
        globs: ["**/*.tsx"],
        description: "React TypeScript components",
        content: "Hybrid content",
        format: "cursor",
        path: ".cursor/rules/hybrid-rule.mdc"
      };
      
      const rulesWithHybrid = [...mockRules, hybridRule];
      
      const options: RuleSuggestOptions = {
        query: "React components",
        filesInContext: ["src/App.tsx"]
      };

      const suggestions = await suggestRules(options, rulesWithHybrid);
      
      // The hybrid rule should appear only once despite matching both glob and query
      const hybridMatches = suggestions.filter(r => r.id === "hybrid-rule");
      expect(hybridMatches).toHaveLength(1);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty rules list", async () => {
      const options: RuleSuggestOptions = {
        query: "anything"
      };

      const suggestions = await suggestRules(options, []);
      expect(suggestions).toEqual([]);
    });

    it("should handle no matching criteria", async () => {
      const options: RuleSuggestOptions = {
        // No query, no files, no manual flag
      };

      const suggestions = await suggestRules(options, mockRules);
      
      // Should only have always-apply rules
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].id).toBe("always-rule-1");
    });

    it("should handle similarity service errors gracefully", async () => {
      const mockSimilarityService = {
        searchByText: mock(() => Promise.reject(new Error("Service unavailable")))
      };

      const options: RuleSuggestOptions = {
        query: "React patterns",
        filesInContext: ["src/App.tsx"]
      };

      // Should not throw, just skip similarity-based suggestions
      const suggestions = await suggestRules(options, mockRules, mockSimilarityService);
      
      // Should still include always-apply and glob-matched rules
      expect(suggestions.find(r => r.id === "always-rule-1")).toBeDefined();
      expect(suggestions.find(r => r.id === "glob-rule-ts")).toBeDefined();
      
      // But no agent-requested rules (similarity failed)
      expect(suggestions.find(r => r.id === "agent-rule-react")).toBeUndefined();
    });
  });

  describe("Rule Ordering", () => {
    it("should maintain consistent ordering: always-apply, auto-attached, agent-requested, manual", async () => {
      const mockSimilarityService = {
        searchByText: mock(() => Promise.resolve([
          { id: "agent-rule-react", score: 0.9 }
        ]))
      };

      const options: RuleSuggestOptions = {
        query: "React",
        filesInContext: ["src/index.ts"],
        includeManual: true
      };

      const suggestions = await suggestRules(options, mockRules, mockSimilarityService);
      
      // Extract rule types in order
      const ruleTypes = suggestions.map(r => {
        if (r.alwaysApply) return "always";
        if (r.globs && r.globs.length > 0) return "auto";
        if (r.description && !r.globs) return "agent";
        return "manual";
      });

      // Check that types appear in the expected order
      const typeOrder = ["always", "auto", "agent", "manual"];
      let lastIndex = -1;
      
      for (const type of ruleTypes) {
        const currentIndex = typeOrder.indexOf(type);
        expect(currentIndex).toBeGreaterThanOrEqual(lastIndex);
        lastIndex = Math.max(lastIndex, currentIndex);
      }
    });
  });
});
