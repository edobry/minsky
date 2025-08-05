/**
 * AI-powered rule suggestion service
 */

import type { AICompletionService, AIObjectGenerationRequest } from "../ai/types";
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

      // Generate AI-powered suggestions
      const aiResponse = await this.generateAISuggestions(request);
      const processingTimeMs = Math.max(1, Date.now() - startTime);

      return {
        ...aiResponse,
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

  private async generateAISuggestions(request: RuleSuggestionRequest): Promise<{
    suggestions: any[];
    queryAnalysis: any;
  }> {
    // Build prompt for AI analysis
    const prompt = this.buildAnalysisPrompt(request);

    try {
      // Use AI service to analyze query and suggest rules
      const response = await this.aiService.generateObject({
        messages: [{ role: "user", content: prompt }],
        schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ruleId: { type: "string" },
                  relevanceScore: { type: "number", minimum: 0, maximum: 1 },
                  reasoning: { type: "string" },
                  confidenceLevel: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["ruleId", "relevanceScore", "reasoning", "confidenceLevel"],
              },
            },
            queryAnalysis: {
              type: "object",
              properties: {
                intent: { type: "string" },
                keywords: { type: "array", items: { type: "string" } },
                suggestedCategories: { type: "array", items: { type: "string" } },
              },
              required: ["intent", "keywords", "suggestedCategories"],
            },
          },
          required: ["suggestions", "queryAnalysis"],
        },
        model: this.config.aiModel || "gpt-4o",
        temperature: 0.3,
      });

      // Filter suggestions based on configuration
      const filteredSuggestions = response.suggestions
        .filter((s: any) => s.relevanceScore >= (this.config.minRelevanceScore ?? 0.1))
        .slice(0, this.config.maxSuggestions ?? 5);

      return {
        suggestions: filteredSuggestions,
        queryAnalysis: response.queryAnalysis,
      };
    } catch (error) {
      // Fallback to basic analysis if AI fails - silently for now since AI is not configured
      return {
        suggestions: [],
        queryAnalysis: await this.analyzeQuery(request.query, request.contextHints),
      };
    }
  }

  private buildAnalysisPrompt(request: RuleSuggestionRequest): string {
    const rules = request.workspaceRules
      .map(
        (rule) => `- ${rule.id}: ${rule.name || rule.id} - ${rule.description || "No description"}`
      )
      .join("\n");

    return `You are helping a developer find relevant coding rules for their task.

Query: "${request.query}"

Available rules:
${rules}

Analyze the query and suggest the most relevant rules. Consider:
1. Keywords and intent in the query
2. Rule descriptions and purposes
3. Common development workflows

For each relevant rule, provide:
- ruleId: exact rule ID from the list
- relevanceScore: 0.0 to 1.0 based on how well it matches
- reasoning: why this rule is relevant (max 100 chars)
- confidenceLevel: "high", "medium", or "low"

Also analyze the query to extract:
- intent: what the user wants to accomplish
- keywords: important terms from the query
- suggestedCategories: general categories this relates to

Only suggest rules that are actually relevant. If no rules match well, return empty suggestions.`;
  }

  private async analyzeQuery(query: string, contextHints: any): Promise<any> {
    // Simple keyword extraction for fallback
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);

    return {
      intent: `User wants help with: ${query}`,
      keywords,
      suggestedCategories: ["general"],
    };
  }
}
