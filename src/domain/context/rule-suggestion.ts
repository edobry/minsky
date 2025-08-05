/**
 * AI-powered rule suggestion service
 */

import { z } from "zod";
import type { AICompletionService, AIObjectGenerationRequest } from "../ai/types";
import type { RulesService } from "../rules/types";
import type { RuleSuggestionRequest, RuleSuggestionResponse, RuleSuggestionConfig } from "./types";
import { RuleSuggestionError } from "./types";

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

    console.log("🤖 Analyzing query with AI...");

    try {
      // Use AI service to analyze query and suggest rules
      const response = await this.aiService.generateObject({
        messages: [{ role: "user", content: prompt }],
        schema: z.object({
          suggestions: z.array(
            z.object({
              ruleId: z.string(),
              relevanceScore: z.number().min(0).max(1),
              reasoning: z.string(),
              confidenceLevel: z.enum(["high", "medium", "low"]),
            })
          ),
          queryAnalysis: z.object({
            intent: z.string(),
            keywords: z.array(z.string()),
            suggestedCategories: z.array(z.string()),
          }),
        }),
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
      // Fallback to keyword-based matching when AI is unavailable
      // AI service failed, falling back to keyword matching
      const fallbackSuggestions = this.generateFallbackSuggestions(request);
      return {
        suggestions: fallbackSuggestions,
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

  private generateFallbackSuggestions(request: RuleSuggestionRequest): any[] {
    const query = request.query.toLowerCase();
    const queryWords = query.split(/\s+/).filter((word) => word.length > 2);

    const suggestions: any[] = [];

    for (const rule of request.workspaceRules) {
      const ruleText = `${rule.id} ${rule.name || ""} ${rule.description || ""}`.toLowerCase();

      let relevanceScore = 0;
      let matchedKeywords: string[] = [];

      // Look for meaningful keyword matches (not just any substring)
      for (const queryWord of queryWords) {
        if (queryWord.length < 3) continue; // Skip very short words

        // Exact word boundary matches in rule text
        const wordBoundaryRegex = new RegExp(`\\b${queryWord}\\b`);
        if (wordBoundaryRegex.test(ruleText)) {
          matchedKeywords.push(queryWord);
          relevanceScore += 0.4;
        }
        // Partial matches in rule ID or name (more specific)
        else if (
          rule.id.toLowerCase().includes(queryWord) ||
          (rule.name && rule.name.toLowerCase().includes(queryWord))
        ) {
          matchedKeywords.push(queryWord);
          relevanceScore += 0.3;
        }
        // Less specific partial matches in description
        else if (rule.description && rule.description.toLowerCase().includes(queryWord)) {
          matchedKeywords.push(queryWord);
          relevanceScore += 0.2;
        }
      }

      // Apply minimum relevance threshold and require at least one match
      if (relevanceScore >= (this.config.minRelevanceScore ?? 0.1) && matchedKeywords.length > 0) {
        suggestions.push({
          ruleId: rule.id,
          relevanceScore: Math.min(relevanceScore, 1.0),
          reasoning: `Matched: ${matchedKeywords.join(", ")}`,
          confidenceLevel: relevanceScore > 0.6 ? "high" : relevanceScore > 0.3 ? "medium" : "low",
        });
      }
    }

    // Sort by relevance and limit results
    return suggestions
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.maxSuggestions ?? 5);
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
