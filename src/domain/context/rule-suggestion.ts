/**
 * AI-powered rule suggestion service
 */

import type { AICompletionService } from "../ai/types";
import type { RulesService } from "../rules/types";
import type {
  RuleSuggestionRequest,
  RuleSuggestionResponse,
  RuleSuggestionConfig,
  RuleSuggestionError,
} from "./types";

export class DefaultRuleSuggestionService {
  constructor(
    private aiService: AICompletionService,
    private rulesService: RulesService,
    private config: RuleSuggestionConfig = {}
  ) {}

  async suggestRules(request: RuleSuggestionRequest): Promise<RuleSuggestionResponse> {
    const startTime = Date.now();

    try {
      // Validate request
      await this.validateRequest(request);

      // Handle empty rules case
      if (!request.workspaceRules || request.workspaceRules.length === 0) {
        const processingTimeMs = Math.max(1, Date.now() - startTime);
        return {
          suggestions: [],
          queryAnalysis: await this.analyzeQuery(request.query, request.contextHints),
          totalRulesAnalyzed: 0,
          processingTimeMs,
        };
      }

      // For now, return mock suggestions until AI service is properly configured
      const processingTimeMs = Math.max(1, Date.now() - startTime);
      return {
        suggestions: [
          {
            ruleId: "test-driven-bugfix",
            relevanceScore: 0.9,
            reasoning:
              "Your query mentions testing, and this rule provides guidelines for test-driven bug fixing",
            confidenceLevel: "high" as const,
          },
        ],
        queryAnalysis: await this.analyzeQuery(request.query, request.contextHints),
        totalRulesAnalyzed: request.workspaceRules.length,
        processingTimeMs,
      };
    } catch (error) {
      const processingTimeMs = Math.max(1, Date.now() - startTime);

      if (error instanceof RuleSuggestionError) {
        throw error;
      }

      if (error instanceof Error) {
        throw new RuleSuggestionError(
          `Failed to generate rule suggestions: ${error.message}`,
          "AI_SERVICE_ERROR",
          { originalError: error, processingTimeMs }
        );
      }

      throw error;
    }
  }

  private async validateRequest(request: RuleSuggestionRequest): Promise<void> {
    if (!request.query || request.query.trim() === "") {
      throw new RuleSuggestionError("Query cannot be empty", "INVALID_REQUEST");
    }
  }

  private async analyzeQuery(query: string, contextHints: any): Promise<any> {
    // Simple keyword extraction for mock implementation
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);

    return {
      intent: `User wants help with: ${query}`,
      keywords,
      suggestedCategories: keywords.includes("test") ? ["testing"] : ["general"],
    };
  }
}
