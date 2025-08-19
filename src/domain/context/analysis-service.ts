/**
 * Context Analysis Service
 *
 * Analyzes discovered context elements for token usage, optimization opportunities,
 * and provides cross-model/tokenizer comparisons.
 */

import type {
  ContextAnalysisRequest,
  ContextAnalysisResult,
  ContextElement,
  ContextDiscoveryOptions,
} from "./types";
import type { DefaultTokenizationService } from "../ai/tokenization/service";
import type { DefaultAICompletionService } from "../ai/completion-service";
import { ContextDiscoveryService } from "./discovery-service";
import { ContextAnalysisError } from "./types";
import { log } from "../../utils/logger";

/**
 * Service for analyzing context composition and token usage
 */
export class ContextAnalysisService {
  private discoveryService: ContextDiscoveryService;
  private tokenizationService: DefaultTokenizationService;
  private aiService?: DefaultAICompletionService;

  constructor(
    tokenizationService: DefaultTokenizationService,
    aiService?: DefaultAICompletionService
  ) {
    this.discoveryService = new ContextDiscoveryService();
    this.tokenizationService = tokenizationService;
    this.aiService = aiService;
  }

  /**
   * Analyze context composition and token usage
   */
  async analyzeContext(request: ContextAnalysisRequest): Promise<ContextAnalysisResult> {
    const startTime = Date.now();

    try {
      log.debug("Starting context analysis", { request });

      // Discover context elements
      const discoveryStart = Date.now();
      const elements = await this.discoverContextElements(request);
      const discoveryTime = Date.now() - discoveryStart;

      if (elements.length === 0) {
        log.warn("No context elements found");
        return this.createEmptyResult(request.model, discoveryTime);
      }

      // Tokenize all elements
      const tokenizationStart = Date.now();
      const tokenizedElements = await this.tokenizeElements(elements, request.model);
      const tokenizationTime = Date.now() - tokenizationStart;

      // Create summary
      const summary = this.createSummary(tokenizedElements, request.model);

      // Create breakdown by type
      const breakdown = this.createBreakdown(tokenizedElements);

      // Sort elements by token count
      const sortedElements = tokenizedElements.sort((a, b) => b.tokenCount - a.tokenCount);
      const rankedElements = sortedElements.map((el, index) => ({
        ...el,
        ranking: index + 1,
      }));

      // Cross-model comparison if requested
      let modelComparison;
      if (request.options?.compareModels?.length) {
        modelComparison = await this.performModelComparison(
          elements,
          request.model,
          request.options.compareModels
        );
      }

      // Tokenizer comparison if requested
      let tokenizerComparison;
      if (request.options?.compareTokenizers) {
        const allContent = elements.map((el) => el.content).join("\n");
        tokenizerComparison = await this.tokenizationService.compareTokenizers(
          allContent,
          request.model
        );
      }

      // Generate optimizations if requested
      let optimizations;
      if (request.options?.includeOptimizations) {
        optimizations = await this.generateOptimizations(tokenizedElements);
      }

      const analysisTime = Date.now() - startTime;

      const result: ContextAnalysisResult = {
        summary,
        breakdown,
        elements: rankedElements,
        modelComparison,
        tokenizerComparison,
        optimizations,
        performance: {
          analysisTime,
          tokenizationTime,
          discoveryTime,
        },
      };

      log.debug("Context analysis completed", {
        totalTokens: summary.totalTokens,
        totalElements: summary.totalElements,
        analysisTime,
      });

      return result;
    } catch (error) {
      log.error("Context analysis failed", { error, request });
      throw new ContextAnalysisError(`Context analysis failed: ${error}`, "ANALYSIS_FAILED", {
        request,
        error,
      });
    }
  }

  /**
   * Discover context elements based on request
   */
  private async discoverContextElements(
    request: ContextAnalysisRequest
  ): Promise<ContextElement[]> {
    const discoveryOptions: ContextDiscoveryOptions = {
      workspacePath: request.workspacePath,
      includeRules: !request.excludeTypes?.includes("rule"),
      includeFiles: !request.excludeTypes?.includes("file"),
      maxFileSize: 50 * 1024, // 50KB max per file
      maxFiles: 30, // Reasonable limit for context
    };

    // Apply include/exclude filters
    const allElements = await this.discoveryService.discoverContext(discoveryOptions);

    let filteredElements = allElements;

    // Apply include types filter
    if (request.includeTypes?.length) {
      filteredElements = filteredElements.filter((el) => request.includeTypes!.includes(el.type));
    }

    // Apply exclude types filter
    if (request.excludeTypes?.length) {
      filteredElements = filteredElements.filter((el) => !request.excludeTypes!.includes(el.type));
    }

    log.debug(`Filtered context elements`, {
      total: allElements.length,
      filtered: filteredElements.length,
      includeTypes: request.includeTypes,
      excludeTypes: request.excludeTypes,
    });

    return filteredElements;
  }

  /**
   * Tokenize all context elements
   */
  private async tokenizeElements(
    elements: ContextElement[],
    model: string
  ): Promise<
    Array<{
      element: ContextElement;
      tokenCount: number;
      percentage: number;
    }>
  > {
    const results = [];
    let totalTokens = 0;

    // First pass: get token counts
    for (const element of elements) {
      try {
        const tokenCount = await this.tokenizationService.countTokens(element.content, model);
        results.push({ element, tokenCount, percentage: 0 });
        totalTokens += tokenCount;
      } catch (error) {
        log.warn(`Failed to tokenize element ${element.id}`, { error });
        results.push({ element, tokenCount: 0, percentage: 0 });
      }
    }

    // Second pass: calculate percentages
    return results.map((result) => ({
      ...result,
      percentage: totalTokens > 0 ? (result.tokenCount / totalTokens) * 100 : 0,
    }));
  }

  /**
   * Create summary information
   */
  private createSummary(
    tokenizedElements: Array<{
      element: ContextElement;
      tokenCount: number;
      percentage: number;
    }>,
    model: string
  ): ContextAnalysisResult["summary"] {
    const totalTokens = tokenizedElements.reduce((sum, el) => sum + el.tokenCount, 0);
    const totalCharacters = tokenizedElements.reduce(
      (sum, el) => sum + el.element.size.characters,
      0
    );

    // Get context window size for model (simplified - would need to lookup actual model info)
    const contextWindow = this.getModelContextWindow(model);
    const utilizationPercentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

    return {
      totalTokens,
      utilizationPercentage,
      totalElements: tokenizedElements.length,
      totalCharacters,
      timestamp: new Date(),
      model,
    };
  }

  /**
   * Create breakdown by element type
   */
  private createBreakdown(
    tokenizedElements: Array<{
      element: ContextElement;
      tokenCount: number;
      percentage: number;
    }>
  ): ContextAnalysisResult["breakdown"] {
    const breakdown: ContextAnalysisResult["breakdown"] = {};

    for (const { element, tokenCount, percentage } of tokenizedElements) {
      if (!breakdown[element.type]) {
        breakdown[element.type] = {
          count: 0,
          tokens: 0,
          percentage: 0,
          characters: 0,
        };
      }

      const typeBreakdown = breakdown[element.type]!;
      typeBreakdown.count++;
      typeBreakdown.tokens += tokenCount;
      typeBreakdown.percentage += percentage;
      typeBreakdown.characters += element.size.characters;

      // Track largest element of this type
      if (
        !typeBreakdown.largestElement ||
        tokenCount > (typeBreakdown.largestElement.tokens || 0)
      ) {
        typeBreakdown.largestElement = {
          id: element.id,
          name: element.name,
          tokens: tokenCount,
        };
      }
    }

    return breakdown;
  }

  /**
   * Perform cross-model comparison
   */
  private async performModelComparison(
    elements: ContextElement[],
    baseModel: string,
    compareModels: string[]
  ): Promise<ContextAnalysisResult["modelComparison"]> {
    const allContent = elements.map((el) => el.content).join("\n");
    const baseTokens = await this.tokenizationService.countTokens(allContent, baseModel);

    const comparisons = [];

    for (const model of compareModels) {
      try {
        const tokenCount = await this.tokenizationService.countTokens(allContent, model);
        const difference = tokenCount - baseTokens;
        const differencePercentage = baseTokens > 0 ? (difference / baseTokens) * 100 : 0;

        comparisons.push({
          model,
          tokenCount,
          difference,
          differencePercentage,
        });
      } catch (error) {
        log.warn(`Failed to compare model ${model}`, { error });
      }
    }

    return comparisons;
  }

  /**
   * Generate optimization suggestions
   */
  private async generateOptimizations(
    tokenizedElements: Array<{
      element: ContextElement;
      tokenCount: number;
      percentage: number;
    }>
  ): Promise<ContextAnalysisResult["optimizations"]> {
    const optimizations = [];

    // Sort by token count to identify largest elements
    const sortedElements = [...tokenizedElements].sort((a, b) => b.tokenCount - a.tokenCount);

    for (const { element, tokenCount, percentage } of sortedElements) {
      // Suggest removing very large elements with low importance
      if (tokenCount > 1000 && element.type === "file") {
        optimizations.push({
          type: "remove" as const,
          elementId: element.id,
          elementName: element.name,
          currentTokens: tokenCount,
          potentialSavings: tokenCount,
          description: `Large file consuming ${tokenCount} tokens (${percentage.toFixed(1)}% of context)`,
          confidence: percentage > 20 ? ("high" as const) : ("medium" as const),
        });
      }

      // Suggest optimizing very long rule files
      if (tokenCount > 500 && element.type === "rule") {
        optimizations.push({
          type: "optimize" as const,
          elementId: element.id,
          elementName: element.name,
          currentTokens: tokenCount,
          potentialSavings: Math.floor(tokenCount * 0.3), // Estimate 30% reduction
          description: `Large rule file could potentially be simplified or split`,
          confidence: "medium" as const,
        });
      }
    }

    // Limit to top 5 suggestions
    return optimizations.slice(0, 5);
  }

  /**
   * Create empty result for when no elements are found
   */
  private createEmptyResult(model: string, discoveryTime: number): ContextAnalysisResult {
    return {
      summary: {
        totalTokens: 0,
        utilizationPercentage: 0,
        totalElements: 0,
        totalCharacters: 0,
        timestamp: new Date(),
        model,
      },
      breakdown: {},
      elements: [],
      performance: {
        analysisTime: discoveryTime,
        tokenizationTime: 0,
        discoveryTime,
      },
    };
  }

  /**
   * Get model context window size (simplified implementation)
   */
  private getModelContextWindow(model: string): number {
    // Simplified mapping - would be better to get from model metadata
    const contextWindows: Record<string, number> = {
      "gpt-4o": 128000,
      "gpt-4o-mini": 128000,
      "gpt-4": 8192,
      "gpt-4-turbo": 128000,
      "gpt-3.5-turbo": 16385,
      "claude-3-5-sonnet": 200000,
      "claude-3-5-haiku": 200000,
      "o1-preview": 128000,
      "o1-mini": 128000,
    };

    // Handle model variants
    for (const [baseModel, contextWindow] of Object.entries(contextWindows)) {
      if (model.startsWith(baseModel)) {
        return contextWindow;
      }
    }

    // Default fallback
    return 128000;
  }
}
