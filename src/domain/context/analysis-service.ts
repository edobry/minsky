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
    const totalTokens = tokenizedElements.reduce((sum, el) => sum + el.tokenCount, 0);

    // Sort by token count to identify largest elements
    const sortedElements = [...tokenizedElements].sort((a, b) => b.tokenCount - a.tokenCount);

    // Calculate thresholds based on context size
    const largeFileThreshold = Math.max(1000, totalTokens * 0.05); // 5% of context or 1000 tokens
    const largeRuleThreshold = Math.max(500, totalTokens * 0.03); // 3% of context or 500 tokens

    for (const { element, tokenCount, percentage } of sortedElements) {
      // 1. Large file removal suggestions
      if (tokenCount > largeFileThreshold && element.type === "file") {
        const confidence = this.calculateRemovalConfidence(element, percentage);
        optimizations.push({
          type: "remove" as const,
          elementId: element.id,
          elementName: element.name,
          currentTokens: tokenCount,
          potentialSavings: tokenCount,
          description: this.generateFileRemovalDescription(element, tokenCount, percentage),
          confidence,
        });
      }

      // 2. Rule optimization suggestions
      if (tokenCount > largeRuleThreshold && element.type === "rule") {
        optimizations.push({
          type: "optimize" as const,
          elementId: element.id,
          elementName: element.name,
          currentTokens: tokenCount,
          potentialSavings: Math.floor(tokenCount * 0.3), // Estimate 30% reduction
          description: `Large rule file could be simplified, split into smaller rules, or use more concise language`,
          confidence: "medium" as const,
        });
      }

      // 3. Test file suggestions
      if (element.name.includes(".test.") || element.name.includes(".spec.")) {
        if (tokenCount > 2000) {
          optimizations.push({
            type: "optimize" as const,
            elementId: element.id,
            elementName: element.name,
            currentTokens: tokenCount,
            potentialSavings: Math.floor(tokenCount * 0.7), // Tests usually not needed in context
            description: `Test file consuming ${tokenCount} tokens - consider excluding test files from context`,
            confidence: "high" as const,
          });
        }
      }

      // 4. Configuration file suggestions
      if (this.isConfigFile(element.name) && tokenCount > 300) {
        optimizations.push({
          type: "optimize" as const,
          elementId: element.id,
          elementName: element.name,
          currentTokens: tokenCount,
          potentialSavings: Math.floor(tokenCount * 0.8),
          description: `Configuration file consuming ${tokenCount} tokens - consider excluding config files unless actively editing`,
          confidence: "medium" as const,
        });
      }
    }

    // 5. Context window utilization suggestions
    const utilizationPercentage = (totalTokens / 128000) * 100; // Assuming 128k context window
    if (utilizationPercentage > 80) {
      optimizations.push({
        type: "restructure" as const,
        elementId: "context-window",
        elementName: "Overall Context",
        currentTokens: totalTokens,
        potentialSavings: Math.floor(totalTokens * 0.2),
        description: `High context utilization (${utilizationPercentage.toFixed(1)}%) - consider using selective inclusion or context chunking`,
        confidence: "high" as const,
      });
    }

    // 6. Duplicate content detection
    const duplicates = this.findDuplicateContent(tokenizedElements);
    for (const duplicate of duplicates) {
      optimizations.push({
        type: "deduplicate" as const,
        elementId: duplicate.elementId,
        elementName: duplicate.elementName,
        currentTokens: duplicate.tokenCount,
        potentialSavings: duplicate.savings,
        description: `Similar content found in multiple files - consider consolidating or referencing`,
        confidence: "medium" as const,
      });
    }

    // Sort by potential savings and limit to top 8 suggestions
    return optimizations.sort((a, b) => b.potentialSavings - a.potentialSavings).slice(0, 8);
  }

  private calculateRemovalConfidence(
    element: ContextElement,
    percentage: number
  ): "high" | "medium" | "low" {
    // High confidence for removing test files, build files, etc.
    if (
      element.name.includes(".test.") ||
      element.name.includes(".spec.") ||
      element.name.includes("node_modules") ||
      element.name.includes(".build")
    ) {
      return "high";
    }

    // High confidence if consuming >15% of context
    if (percentage > 15) {
      return "high";
    }

    // Medium confidence for large files
    if (percentage > 8) {
      return "medium";
    }

    return "low";
  }

  private generateFileRemovalDescription(
    element: ContextElement,
    tokenCount: number,
    percentage: number
  ): string {
    const baseDesc = `Large file consuming ${tokenCount} tokens (${percentage.toFixed(1)}% of context)`;

    if (element.name.includes(".test.") || element.name.includes(".spec.")) {
      return `${baseDesc} - Test file can usually be excluded from context`;
    }

    if (element.name.includes("package.json") || element.name.includes("tsconfig")) {
      return `${baseDesc} - Configuration file rarely needed in AI context`;
    }

    if (element.name.includes(".d.ts")) {
      return `${baseDesc} - Type definition file can often be excluded`;
    }

    return baseDesc;
  }

  private isConfigFile(fileName: string): boolean {
    const configPatterns = [
      "package.json",
      "tsconfig",
      "eslint",
      "prettier",
      ".env",
      "webpack",
      "rollup",
      "vite",
      "babel",
      "jest",
      "vitest",
      ".gitignore",
      ".dockerignore",
      "Dockerfile",
      "docker-compose",
    ];

    return configPatterns.some((pattern) => fileName.includes(pattern));
  }

  private findDuplicateContent(
    tokenizedElements: Array<{ element: ContextElement; tokenCount: number }>
  ): Array<{
    elementId: string;
    elementName: string;
    tokenCount: number;
    savings: number;
  }> {
    // Simple implementation - could be enhanced with actual content similarity analysis
    const duplicates = [];
    const nameGroups = new Map<string, Array<{ element: ContextElement; tokenCount: number }>>();

    // Group by similar names (basic heuristic)
    for (const item of tokenizedElements) {
      const baseName = item.element.name.replace(/\.(ts|js|tsx|jsx)$/, "").toLowerCase();
      if (!nameGroups.has(baseName)) {
        nameGroups.set(baseName, []);
      }
      nameGroups.get(baseName)!.push(item);
    }

    // Find groups with multiple files
    for (const [baseName, group] of nameGroups) {
      if (group.length > 1) {
        // Suggest removing smaller duplicates
        const sorted = group.sort((a, b) => b.tokenCount - a.tokenCount);
        for (let i = 1; i < sorted.length && i < 3; i++) {
          duplicates.push({
            elementId: sorted[i].element.id,
            elementName: sorted[i].element.name,
            tokenCount: sorted[i].tokenCount,
            savings: sorted[i].tokenCount,
          });
        }
      }
    }

    return duplicates.slice(0, 3); // Limit to avoid spam
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
