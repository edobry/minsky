import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ComponentInput } from "./types";
import type { Rule } from "../../rules/types";
import { RuleType } from "../../rules/rule-classifier";

describe("Workspace Rules Component - Isolated Unit Tests", () => {
  // Mock rules for testing - avoid real resources
  const mockRules: Rule[] = [
    {
      id: "always-lint",
      name: "Always Lint",
      alwaysApply: true,
      content: "Always run linter before commit",
      format: "cursor",
      path: ".cursor/rules/always-lint.mdc",
    },
    {
      id: "typescript-rules",
      name: "TypeScript Guidelines",
      globs: ["**/*.ts", "**/*.tsx"],
      description: "TypeScript coding standards",
      content: "Use strict mode",
      format: "cursor",
      path: ".cursor/rules/typescript-rules.mdc",
    },
    {
      id: "react-patterns",
      name: "React Patterns",
      description: "React component patterns and best practices",
      content: "Prefer functional components",
      format: "cursor",
      path: ".cursor/rules/react-patterns.mdc",
    },
    {
      id: "manual-deploy",
      name: "Deployment Guide",
      content: "Manual deployment steps",
      format: "cursor",
      path: ".cursor/rules/manual-deploy.mdc",
    },
  ];

  let mockRulesService: any;

  beforeEach(() => {
    // Complete isolation - no real service calls
    mockRulesService = {
      listRules: mock(() => Promise.resolve(mockRules)),
    };
  });

  describe("Component Integration", () => {
    it("should validate that core dependencies are available", () => {
      // Test that the required modules exist without calling them
      const { classifyRuleType, RuleType } = require("../../rules/rule-classifier");
      const { extractRuleMentions } = require("../../rules/rule-mention-parser");
      const { matchesGlobPatterns } = require("../../rules/glob-matcher");

      expect(classifyRuleType).toBeDefined();
      expect(RuleType).toBeDefined();
      expect(extractRuleMentions).toBeDefined();
      expect(matchesGlobPatterns).toBeDefined();
    });

    it("should have proper type definitions for enhanced inputs", () => {
      // Verify the ComponentInput type supports our new fields
      const mockInput: ComponentInput = {
        userQuery: "test",
        filesInContext: ["test.ts"],
        rulesService: mockRulesService,
        workspacePath: "/test",
      };

      // These should not cause TypeScript errors
      expect(mockInput.userQuery).toBe("test");
      expect(mockInput.filesInContext).toEqual(["test.ts"]);
      expect(mockInput.rulesService).toBe(mockRulesService);
    });
  });

  describe("Output Format Validation", () => {
    it("should generate proper XML structure in output", async () => {
      const { WorkspaceRulesComponent } = await import("./workspace-rules");

      const inputs = {
        requestableRules: [mockRules[0], mockRules[1], mockRules[2]], // Always, auto, agent
        totalRules: mockRules.length,
        filteredCount: 3,
        filteredBy: "enhanced-suggestion",
        rulesByType: {
          [RuleType.ALWAYS_APPLY]: [mockRules[0]],
          [RuleType.AUTO_ATTACHED]: [mockRules[1]],
          [RuleType.AGENT_REQUESTED]: [mockRules[2]],
          [RuleType.MANUAL]: [],
        },
      };

      const output = WorkspaceRulesComponent.render(inputs, {});

      // Should contain proper XML structure
      expect(output.content).toContain("<rules>");
      expect(output.content).toContain("<agent_requestable_workspace_rules");
      expect(output.content).toContain("</agent_requestable_workspace_rules>");
      expect(output.content).toContain("</rules>");

      // Should include rule content properly
      expect(output.content).toContain("Always Lint: Use this when working with Always Lint");
      expect(output.content).toContain("TypeScript Guidelines: TypeScript coding standards");

      // Manual rule should be excluded from agent_requestable section
      expect(output.content).not.toContain(
        "Deployment Guide: Use this when working with Deployment Guide"
      );
    });

    it("should include metadata when filtering applied", async () => {
      const { WorkspaceRulesComponent } = await import("./workspace-rules");

      const inputs = {
        requestableRules: mockRules.slice(0, 2),
        totalRules: mockRules.length,
        filteredCount: 2,
        filteredBy: "enhanced-suggestion",
        queryUsed: "testing",
        reductionPercentage: 50,
      };

      const output = WorkspaceRulesComponent.render(inputs, {});

      // Should include filtering metadata
      expect(output.metadata?.filteredBy).toBe("enhanced-suggestion");
      expect(output.metadata?.queryUsed).toBe("testing");
      expect(output.metadata?.reductionPercentage).toBe(50);
    });
  });

  describe("Component Function Testing", () => {
    it("should have proper render function behavior", () => {
      // Test the render function directly without calling gatherInputs
      const { WorkspaceRulesComponent } = require("./workspace-rules");

      const inputs = {
        requestableRules: [mockRules[0], mockRules[1]], // always and auto-attached rules
        totalRules: mockRules.length,
        filteredCount: 2,
        filteredBy: "test-filtering",
        queryUsed: "test query",
        reductionPercentage: 50,
      };

      const output = WorkspaceRulesComponent.render(inputs, {});

      // Should generate output without errors
      expect(output.content).toBeDefined();
      expect(output.metadata?.filteredBy).toBe("test-filtering");
      expect(output.metadata?.queryUsed).toBe("test query");
      expect(output.metadata?.reductionPercentage).toBe(50);
    });

    it("should handle legacy generate function for backward compatibility", () => {
      const { WorkspaceRulesComponent } = require("./workspace-rules");

      const context = {
        userPrompt: "test prompt",
        workspacePath: "/test/workspace",
      };

      // The legacy generate function should exist and work
      expect(WorkspaceRulesComponent.generate).toBeDefined();
      expect(typeof WorkspaceRulesComponent.generate).toBe("function");
    });
  });
});
