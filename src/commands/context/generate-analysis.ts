/**
 * Context analysis functions for the generate command
 *
 * Handles token analysis, model context windows, and optimization suggestions.
 */

import { DefaultTokenizationService } from "../../domain/ai/tokenization/index";
import type {
  GenerateResult,
  GenerateOptions,
  AnalysisResult,
  ComponentBreakdown,
  OptimizationSuggestion,
} from "./generate-types";

/**
 * Get context window size for different models
 */
export function getModelContextWindow(model: string): number {
  const contextWindows: Record<string, number> = {
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4": 8192,
    "gpt-4-32k": 32768,
    "gpt-3.5-turbo": 16385,
    "gpt-3.5-turbo-16k": 16385,
    "claude-3-5-sonnet": 200000,
    "claude-3-5-sonnet-20241022": 200000,
    "claude-3-5-haiku": 200000,
    "claude-3-opus": 200000,
    "claude-3-sonnet": 200000,
    "claude-3-haiku": 200000,
    "claude-2.1": 200000,
    "claude-2": 100000,
    "claude-instant-1.2": 100000,
  };

  // Try exact match first
  if (contextWindows[model]) {
    return contextWindows[model];
  }

  // Try partial matches for Claude models
  if (model.includes("claude-3.5") || model.includes("claude-3")) {
    return 200000;
  }
  if (model.includes("claude-2")) {
    return 200000;
  }
  if (model.includes("claude")) {
    return 100000; // Conservative fallback for Claude
  }

  // Try partial matches for GPT models
  if (model.includes("gpt-4o")) {
    return 128000;
  }
  if (model.includes("gpt-4") && model.includes("32k")) {
    return 32768;
  }
  if (model.includes("gpt-4")) {
    return 8192;
  }
  if (model.includes("gpt-3.5")) {
    return 16385;
  }

  // Default fallback
  return 128000;
}

/**
 * Analyze the generated context for token usage and optimization opportunities
 */
export async function analyzeGeneratedContext(
  result: GenerateResult,
  options: GenerateOptions
): Promise<AnalysisResult> {
  const tokenizationService = new DefaultTokenizationService();
  const targetModel = options.model || "gpt-4o";

  // Analyze each component's token usage
  const componentAnalysis: ComponentBreakdown[] = [];
  for (const component of result.components) {
    const tokens = await tokenizationService.countTokens(component.content, targetModel);
    const percentage = result.metadata.totalTokens
      ? (tokens / result.metadata.totalTokens) * 100
      : 0;

    componentAnalysis.push({
      component: component.component_id,
      tokens,
      percentage: percentage.toFixed(1),
      content_length: component.content.length,
    });
  }

  // Sort by token usage (largest first)
  componentAnalysis.sort((a, b) => b.tokens - a.tokens);

  // Get model-specific context window size
  const contextWindowSize = getModelContextWindow(targetModel);

  // Generate optimization suggestions
  const optimizations = generateContextOptimizations(
    componentAnalysis,
    result.metadata.totalTokens || 0
  );

  // Get tokenizer information
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getTokenizerInfo is an optional extension not in the base TokenizationService interface
  const tokenizerInfo = (tokenizationService as any).getTokenizerInfo?.(targetModel) || {
    name: "tiktoken",
    encoding: "cl100k_base",
    description: "OpenAI tokenizer",
  };

  return {
    metadata: {
      model: targetModel,
      tokenizer: tokenizerInfo,
      interface: options.interface || "cli",
      contextWindowSize,
      analysisTimestamp: new Date().toISOString(),
      generationTime: result.metadata.generationTime,
    },
    summary: {
      totalTokens: result.metadata.totalTokens || 0,
      totalComponents: result.components.length,
      averageTokensPerComponent: componentAnalysis.length
        ? Math.round((result.metadata.totalTokens || 0) / componentAnalysis.length)
        : 0,
      largestComponent: componentAnalysis[0]?.component || "none",
      contextWindowUtilization: ((result.metadata.totalTokens || 0) / contextWindowSize) * 100,
    },
    componentBreakdown: componentAnalysis,
    optimizations,
    // Include full result for sub-component parsing
    fullResult: result,
  };
}

/**
 * Generate optimization suggestions based on component analysis
 */
export function generateContextOptimizations(
  componentAnalysis: ComponentBreakdown[],
  totalTokens: number
): OptimizationSuggestion[] {
  const optimizations: OptimizationSuggestion[] = [];

  for (const component of componentAnalysis) {
    const percentage = parseFloat(component.percentage);
    const tokens = component.tokens;

    // Prioritize suggestions to avoid redundancy
    if (tokens > 10000 && percentage > 50) {
      // Very large component that dominates context
      optimizations.push({
        type: "reduce",
        component: component.component,
        currentTokens: tokens,
        suggestion: `Component "${component.component}" dominates your context (${tokens.toLocaleString()} tokens, ${component.percentage}%). Consider reducing its scope, splitting it into smaller components, or using only essential parts.`,
        confidence: "high",
        potentialSavings: Math.floor(tokens * 0.4),
      });
    } else if (tokens > 10000) {
      // Large component but not dominating
      optimizations.push({
        type: "reduce",
        component: component.component,
        currentTokens: tokens,
        suggestion: `Component "${component.component}" is very large (${tokens.toLocaleString()} tokens). Consider reducing its scope or splitting it into smaller components.`,
        confidence: "high",
        potentialSavings: Math.floor(tokens * 0.3),
      });
    } else if (percentage > 30) {
      // Smaller but high-percentage component
      optimizations.push({
        type: "review",
        component: component.component,
        currentTokens: tokens,
        suggestion: `Component "${component.component}" consumes ${component.percentage}% of your context. Consider if all this content is necessary for your use case.`,
        confidence: "medium",
        potentialSavings: Math.floor(tokens * 0.2),
      });
    } else if (percentage > 20 && tokens > 5000) {
      // Medium-sized component that could be optimized
      optimizations.push({
        type: "optimize",
        component: component.component,
        currentTokens: tokens,
        suggestion: `Component "${component.component}" could be optimized (${tokens.toLocaleString()} tokens, ${component.percentage}%). Review if all content is essential.`,
        confidence: "medium",
        potentialSavings: Math.floor(tokens * 0.15),
      });
    }
  }

  // No overall context window warning needed here since we show utilization in metadata
  // Individual component suggestions are more actionable

  return optimizations.slice(0, 5); // Limit to top 5 suggestions
}
