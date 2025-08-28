import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ComponentInput } from "./types";
import type { Rule } from "../../rules/types";
import { WorkspaceRulesComponent } from "./workspace-rules";

describe("Enhanced Workspace Rules Component with Context-Aware Filtering", () => {
  // Mock rules for testing
  const mockRules: Rule[] = [
    {
      id: "always-lint",
      name: "Always Lint",
      alwaysApply: true,
      content: "Always run linter before commit",
      format: "cursor",
      path: ".cursor/rules/always-lint.mdc"
    },
    {
      id: "typescript-rules",
      name: "TypeScript Guidelines",
      globs: ["**/*.ts", "**/*.tsx"],
      description: "TypeScript coding standards",
      content: "Use strict mode",
      format: "cursor",
      path: ".cursor/rules/typescript-rules.mdc"
    },
    {
      id: "react-patterns",
      name: "React Patterns",
      description: "React component patterns and best practices",
      content: "Prefer functional components",
      format: "cursor",
      path: ".cursor/rules/react-patterns.mdc"
    },
    {
      id: "test-conventions",
      name: "Test Conventions",
      globs: ["**/*.test.ts", "**/*.spec.ts"],
      content: "Use describe/it blocks",
      format: "cursor",
      path: ".cursor/rules/test-conventions.mdc"
    },
    {
      id: "manual-deploy",
      name: "Deployment Guide",
      content: "Manual deployment steps",
      format: "cursor",
      path: ".cursor/rules/manual-deploy.mdc"
    }
  ];

  let mockRulesService: any;
  let mockSuggestRules: any;

  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    
    // Mock the rules service
    mockRulesService = {
      listRules: mock(() => Promise.resolve(mockRules))
    };
    
    // Mock the enhanced suggestRules function
    mockSuggestRules = mock((options: any) => {
      // Simulate the enhanced suggestion logic
      const suggestions: Rule[] = [];
      
      // Always include always-apply rules
      suggestions.push(...mockRules.filter(r => r.alwaysApply));
      
      // Include glob-matched rules if files in context
      if (options.filesInContext && options.filesInContext.length > 0) {
        // Simplified glob matching for test
        if (options.filesInContext.some((f: string) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
          suggestions.push(mockRules.find(r => r.id === "typescript-rules")!);
        }
        if (options.filesInContext.some((f: string) => f.includes('.test.') || f.includes('.spec.'))) {
          suggestions.push(mockRules.find(r => r.id === "test-conventions")!);
        }
      }
      
      // Include query-matched rules
      if (options.query) {
        if (options.query.toLowerCase().includes('react')) {
          suggestions.push(mockRules.find(r => r.id === "react-patterns")!);
        }
      }
      
      // Remove duplicates
      return Array.from(new Map(suggestions.map(r => [r.id, r])).values());
    });
  });

  describe("Context-Aware Rule Filtering", () => {
    it("should use enhanced rule suggestion when user query is provided", async () => {
      const context: ComponentInput = {
        userQuery: "how to build React components",
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should have filtered rules based on query
      expect(inputs.filteredBy).toBe("enhanced-suggestion");
      expect(inputs.queryUsed).toBe("how to build React components");
      
      // Should categorize rules by type
      expect(inputs.rulesByType).toBeDefined();
      expect(inputs.rulesByType.always).toBeDefined();
      expect(inputs.rulesByType.agentRequested).toBeDefined();
    });

    it("should include files in context for glob matching", async () => {
      const context: ComponentInput = {
        userQuery: "fix TypeScript errors",
        filesInContext: [
          "src/components/Button.tsx",
          "src/utils/helper.ts",
          "src/components/Button.test.ts"
        ],
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should pass files to suggestion system
      expect(mockSuggestRules).toHaveBeenCalledWith(
        expect.objectContaining({
          filesInContext: context.filesInContext
        })
      );
      
      // Should have rules that match the file patterns
      const ruleIds = inputs.requestableRules.map((r: Rule) => r.id);
      expect(ruleIds).toContain("typescript-rules"); // Matches .ts/.tsx files
      expect(ruleIds).toContain("test-conventions"); // Matches .test.ts file
    });

    it("should fall back to all rules when no query or files provided", async () => {
      const context: ComponentInput = {
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should use original behavior - all rules
      expect(inputs.filteredBy).toBe("all-rules");
      expect(inputs.requestableRules).toHaveLength(mockRules.length);
    });

    it("should handle empty files in context", async () => {
      const context: ComponentInput = {
        userQuery: "setup project",
        filesInContext: [],
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should still work with empty files
      expect(inputs.filteredBy).toBe("enhanced-suggestion");
      // Should at least have always-apply rules
      expect(inputs.requestableRules.length).toBeGreaterThan(0);
    });
  });

  describe("Rule Type Organization in Output", () => {
    it("should group rules by type in the rendered output", async () => {
      const inputs = {
        requestableRules: mockRules,
        totalRules: mockRules.length,
        filteredCount: mockRules.length,
        filteredBy: "enhanced-suggestion",
        rulesByType: {
          always: [mockRules[0]], // always-lint
          autoAttached: [mockRules[1], mockRules[3]], // typescript-rules, test-conventions
          agentRequested: [mockRules[2]], // react-patterns
          manual: [mockRules[4]] // manual-deploy
        }
      };

      const output = WorkspaceRulesComponent.render(inputs, {});
      
      // Check that output contains organized sections
      expect(output.content).toContain("<agent_requestable_workspace_rules");
      expect(output.content).toContain("always-lint: Always run linter");
      expect(output.content).toContain("typescript-rules: TypeScript coding standards");
      expect(output.content).toContain("react-patterns: React component patterns");
      
      // Manual rules should not appear in agent_requestable section
      expect(output.content).not.toContain("manual-deploy: Manual deployment");
    });

    it("should include filtering metadata in output when query filtering applied", async () => {
      const inputs = {
        requestableRules: mockRules.slice(0, 3),
        totalRules: mockRules.length,
        filteredCount: 3,
        filteredBy: "enhanced-suggestion",
        queryUsed: "React development",
        reductionPercentage: 40,
        rulesByType: {
          always: [mockRules[0]],
          autoAttached: [mockRules[1]],
          agentRequested: [mockRules[2]],
          manual: []
        }
      };

      const output = WorkspaceRulesComponent.render(inputs, {});
      
      // Should include metadata about filtering
      expect(output.metadata.filteredBy).toBe("enhanced-suggestion");
      expect(output.metadata.queryUsed).toBe("React development");
      expect(output.metadata.reductionPercentage).toBe(40);
    });
  });

  describe("Error Handling", () => {
    it("should fall back to simple filtering on suggestion service error", async () => {
      // Mock suggestion service to throw error
      mockSuggestRules = mock(() => {
        throw new Error("Suggestion service unavailable");
      });

      const context: ComponentInput = {
        userQuery: "React patterns",
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should fall back to simple string filtering
      expect(inputs.filteredBy).toBe("simple-filter-fallback");
      
      // Should still have some results from fallback
      expect(inputs.requestableRules.length).toBeGreaterThan(0);
    });

    it("should handle missing similarity service gracefully", async () => {
      // Mock module not found for similarity service
      mock.module("../../rules/rule-suggestion-enhanced", () => {
        throw new Error("Module not found");
      });

      const context: ComponentInput = {
        userQuery: "testing",
        filesInContext: ["test.ts"],
        workspacePath: "/test/workspace"
      };

      // Should not throw, just use fallback
      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      expect(inputs.filteredBy).toBe("simple-filter-fallback");
    });
  });

  describe("Backward Compatibility", () => {
    it("should maintain existing behavior when no context enhancements available", async () => {
      const context: ComponentInput = {
        userPrompt: "implement feature", // Old field name
        workspacePath: "/test/workspace"
        // No userQuery or filesInContext
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // Should still work with userPrompt
      expect(inputs.userPrompt).toBe("implement feature");
      
      // Should filter based on prompt text
      expect(inputs.filteredCount).toBeLessThanOrEqual(inputs.totalRules);
    });

    it("should handle both userQuery and userPrompt with userQuery taking precedence", async () => {
      const context: ComponentInput = {
        userQuery: "new query",
        userPrompt: "old prompt",
        workspacePath: "/test/workspace"
      };

      const inputs = await WorkspaceRulesComponent.gatherInputs(context);
      
      // userQuery should take precedence
      expect(inputs.queryUsed).toBe("new query");
    });
  });
});
