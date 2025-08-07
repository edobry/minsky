/**
 * Simplified integration test for suggest-rules functionality
 *
 * Tests the core service integration with mocked AI and real rule data structures.
 */

import { describe, it, expect, beforeAll, mock } from "bun:test";
import { DefaultRuleSuggestionService } from "../../domain/context/rule-suggestion";
import type { RuleSuggestionRequest } from "../../domain/context/types";
import type { Rule } from "../../domain/rules/types";

describe("suggest-rules service integration", () => {
  let mockAIService: any;
  let mockRulesService: any;
  let suggestionService: DefaultRuleSuggestionService;
  let sampleRules: Rule[];

  beforeAll(async () => {
    // Create sample rules that match the real data structure
    sampleRules = [
      {
        id: "test-driven-bugfix",
        name: "Test-Driven Bug Fixing",
        description: "Use this when fixing a bug or error of any kind",
        content: "Test-driven development workflow for bug fixes...",
        tags: ["testing", "bugfix", "workflow"],
        format: "cursor" as const,
        path: "/rules/test-driven-bugfix.mdc",
      },
      {
        id: "domain-oriented-modules",
        name: "Domain-Oriented Modules",
        description: "Use this when deciding where to put code, or when refactoring modules",
        content: "Guidelines for organizing code into domain modules...",
        tags: ["architecture", "organization"],
        format: "cursor" as const,
        path: "/rules/domain-oriented-modules.mdc",
      },
      {
        id: "error-handling-router",
        name: "Error Handling Router",
        description: "REQUIRED entry point for all error handling decisions",
        content: "Router for error handling patterns...",
        tags: ["error-handling", "router"],
        format: "cursor" as const,
        path: "/rules/error-handling-router.mdc",
      },
    ];

    // Create mock AI service with predictable responses
    mockAIService = {
      generateObject: mock(async (request: any) => {
        const prompt = request.messages[0].content;

        if (prompt.includes("refactor this code and organize it better")) {
          return {
            suggestions: [
              {
                ruleId: "domain-oriented-modules",
                relevanceScore: 0.8,
                reasoning:
                  "Query about refactoring code organization matches domain module guidelines.",
                confidenceLevel: "high",
              },
            ],
            queryAnalysis: {
              intent: "Reorganize code into better modules",
              keywords: ["refactor", "organize", "modules"],
              suggestedCategories: ["architecture", "organization"],
            },
            usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 },
            model: "gpt-4o",
            finishReason: "stop",
          };
        } else if (prompt.includes("fix a bug in the code")) {
          return {
            suggestions: [
              {
                ruleId: "test-driven-bugfix",
                relevanceScore: 0.9,
                reasoning:
                  "The query mentions fixing a bug, which directly matches the test-driven-bugfix rule purpose.",
                confidenceLevel: "high",
              },
            ],
            queryAnalysis: {
              intent: "Fix a reported bug",
              keywords: ["fix", "bug"],
              suggestedCategories: ["testing", "bugfix"],
            },
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: "gpt-4o",
            finishReason: "stop",
          };
        } else {
          return {
            suggestions: [],
            queryAnalysis: {
              intent: "General query",
              keywords: ["query"],
              suggestedCategories: [],
            },
            usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
            model: "gpt-4o",
            finishReason: "stop",
          };
        }
      }),
    };

    // Create mock rules service
    mockRulesService = {
      listRules: mock(() => Promise.resolve(sampleRules)),
    };

    // Initialize suggestion service
    suggestionService = new DefaultRuleSuggestionService(mockAIService, mockRulesService, {
      maxSuggestions: 5,
      minRelevanceScore: 0.1,
    });
  });

  it("should suggest relevant rules for bug fixing query", async () => {
    const request: RuleSuggestionRequest = {
      query: "I need to fix a bug in the code",
      workspaceRules: sampleRules,
      contextHints: {
        currentFiles: ["src/auth/login.ts"],
        projectType: "typescript",
      },
    };

    const response = await suggestionService.suggestRules(request);

    // Verify response structure
    expect(response.suggestions).toBeArray();
    expect(response.suggestions.length).toBe(1);
    expect(response.suggestions[0].ruleId).toBe("test-driven-bugfix");
    expect(response.suggestions[0].relevanceScore).toBe(0.9);
    expect(response.suggestions[0].confidenceLevel).toBe("high");
    expect(response.queryAnalysis.intent).toContain("bug");
    expect(response.totalRulesAnalyzed).toBe(3);
  });

  it("should suggest domain rules for refactoring query", async () => {
    const request: RuleSuggestionRequest = {
      query: "I want to refactor this code and organize it better",
      workspaceRules: sampleRules,
    };

    const response = await suggestionService.suggestRules(request);

    expect(response.suggestions).toBeArray();
    expect(response.suggestions.length).toBe(1);
    expect(response.suggestions[0].ruleId).toBe("domain-oriented-modules");
    expect(response.suggestions[0].relevanceScore).toBe(0.8);
    expect(response.queryAnalysis.intent).toContain("modules");
  });

  it("should handle empty rule sets gracefully", async () => {
    const request: RuleSuggestionRequest = {
      query: "I need help with testing",
      workspaceRules: [],
    };

    const response = await suggestionService.suggestRules(request);

    expect(response.suggestions).toHaveLength(0);
    expect(response.totalRulesAnalyzed).toBe(0);
    expect(response.queryAnalysis).toBeDefined();
  });

  it("should filter suggestions based on relevance threshold", async () => {
    // Create service with higher threshold
    const strictService = new DefaultRuleSuggestionService(
      mockAIService,
      mockRulesService,
      { minRelevanceScore: 0.95 } // Higher than our mock's 0.9 score
    );

    const request: RuleSuggestionRequest = {
      query: "I need to fix a bug",
      workspaceRules: sampleRules,
    };

    const response = await strictService.suggestRules(request);

    // Should filter out the 0.9 relevance suggestion
    expect(response.suggestions).toHaveLength(0);
  });

  it("should respect max suggestions configuration", async () => {
    // Mock AI service to return multiple suggestions
    const multiMockAI = {
      generateObject: mock(async () => ({
        suggestions: [
          {
            ruleId: "test-driven-bugfix",
            relevanceScore: 0.9,
            reasoning: "High relevance",
            confidenceLevel: "high",
          },
          {
            ruleId: "domain-oriented-modules",
            relevanceScore: 0.8,
            reasoning: "Medium relevance",
            confidenceLevel: "medium",
          },
          {
            ruleId: "error-handling-router",
            relevanceScore: 0.7,
            reasoning: "Lower relevance",
            confidenceLevel: "medium",
          },
        ],
        queryAnalysis: {
          intent: "Multiple relevant tasks",
          keywords: ["multiple"],
          suggestedCategories: ["testing", "architecture"],
        },
        usage: { promptTokens: 150, completionTokens: 75, totalTokens: 225 },
        model: "gpt-4o",
        finishReason: "stop",
      })),
    };

    const limitedService = new DefaultRuleSuggestionService(multiMockAI, mockRulesService, {
      maxSuggestions: 2,
    });

    const request: RuleSuggestionRequest = {
      query: "I need help with multiple things",
      workspaceRules: sampleRules,
    };

    const response = await limitedService.suggestRules(request);

    expect(response.suggestions).toHaveLength(2); // Limited to 2
    expect(response.suggestions[0].relevanceScore).toBeGreaterThan(
      response.suggestions[1].relevanceScore
    ); // Sorted by relevance
  });

  it("should provide performance metrics", async () => {
    const request: RuleSuggestionRequest = {
      query: "performance test",
      workspaceRules: sampleRules,
    };

    const response = await suggestionService.suggestRules(request);

    expect(response.processingTimeMs).toBeGreaterThan(0);
    expect(response.totalRulesAnalyzed).toBe(3);
  });

  it("should handle AI service errors gracefully", async () => {
    const errorMockAI = {
      generateObject: mock(async () => {
        throw new Error("AI service unavailable");
      }),
    };

    const errorService = new DefaultRuleSuggestionService(errorMockAI, mockRulesService, {});

    const request: RuleSuggestionRequest = {
      query: "test error handling",
      workspaceRules: sampleRules,
    };

    // The service should gracefully fall back to keyword-based suggestions, not throw
    const response = await errorService.suggestRules(request);
    
    // Should return a valid response with fallback suggestions
    expect(response.suggestions).toBeDefined();
    expect(Array.isArray(response.suggestions)).toBe(true);
    expect(response.queryAnalysis).toBeDefined();
    // Note: The service provides resilient fallback, not error propagation
  });
});
