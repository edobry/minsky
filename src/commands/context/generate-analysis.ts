/**
 * Context analysis functions for the generate command
 *
 * Handles token analysis, model context windows, and optimization suggestions.
 */

import { DefaultTokenizationService } from "@minsky/domain/ai/tokenization/index";
import type { TokenizerMetadata } from "@minsky/domain/ai/tokenization/index";
import { DefaultModelCacheService } from "@minsky/domain/ai/model-cache/index";
import { log } from "@minsky/shared/logger";
import type {
  GenerateResult,
  GenerateOptions,
  AnalysisResult,
  ComponentBreakdown,
  OptimizationSuggestion,
  TokenizerInfo,
} from "./generate-types";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * The subset of the model cache this module reads.
 *
 * Declared structurally so a test can supply a stub instead of standing up the
 * real file-backed cache service.
 */
export interface CachedModelLimitSource {
  getAllCachedModels(): Promise<Record<string, { id: string; contextWindow: number }[]>>;
}

/**
 * Compile-time proof that the real cache service satisfies the narrow read
 * interface above. The default-parameter site already enforces this, but naming
 * the contract makes the coupling explicit: if `getAllCachedModels` changes
 * shape, the build fails here rather than the mismatch reaching runtime.
 */
type AssertTrue<T extends true> = T;
export type CacheServiceSatisfiesLimitSource = AssertTrue<
  DefaultModelCacheService extends CachedModelLimitSource ? true : false
>;

/** Rendered wherever a model's context window could not be resolved. */
export const UNKNOWN_CONTEXT_WINDOW_LABEL = "unknown (model not in the local model cache)";

/** Rendered wherever utilization is uncomputable because the window is unknown. */
export const UNKNOWN_UTILIZATION_LABEL = "unknown (context window unavailable)";

export function formatContextWindowSize(size: number | null): string {
  return size === null ? UNKNOWN_CONTEXT_WINDOW_LABEL : `${size.toLocaleString()} tokens`;
}

/**
 * `compact` yields a bare "unknown" for fixed-width table cells; the default
 * long form explains itself and suits a standalone line.
 */
export function formatContextWindowUtilization(
  utilization: number | null,
  options: { compact?: boolean } = {}
): string {
  if (utilization !== null) {
    return `${utilization.toFixed(1)}%`;
  }
  return options.compact ? "unknown" : UNKNOWN_UTILIZATION_LABEL;
}

/** The subset of the tokenization service the tokenizer description reads. */
export interface TokenizerMetadataSource {
  getTokenizerMetadata(model: string): Promise<TokenizerMetadata | null>;
}

/**
 * What the analysis reports about the tokenizer that produced its counts.
 *
 * This used to be a hardcoded `{ name: "tiktoken", encoding: "cl100k_base" }`
 * literal: the call it appeared to make was `getTokenizerInfo`, which
 * `DefaultTokenizationService` does not implement, so the optional-call
 * `?.()` returned undefined on EVERY invocation and the `||` default was the
 * only value the display ever showed (mt#3928). It reported `cl100k_base` for
 * an Anthropic model because it reported `cl100k_base` for everything,
 * including models that do not exist.
 */
export async function describeTokenizer(
  source: TokenizerMetadataSource,
  model: string
): Promise<TokenizerInfo> {
  const metadata = await source.getTokenizerMetadata(model);

  if (!metadata) {
    return {
      name: "none",
      encoding: "unknown",
      description: `No tokenizer could be resolved for ${model}`,
      approximated: true,
    };
  }

  return {
    name: metadata.library ?? "unknown",
    encoding: metadata.id,
    description: metadata.approximated
      ? `${metadata.id} — an approximation; no tokenizer registered for ${model}`
      : `${metadata.id} tokenizer for ${model}`,
    approximated: metadata.approximated,
  };
}

/**
 * The note qualifying a count produced by a tokenizer not made for the model,
 * or null when the tokenizer was a genuine match.
 *
 * Names the substitute rather than asserting "an OpenAI encoding": the
 * registry's `defaultLibrary` is configurable (`TokenizerConfig`), so that
 * phrasing was a claim this code never checked — and repeating the unverified
 * half of a figure is the habit this whole task is about (PR #2801 R1). It
 * also stops the encoding beside it reading as the MODEL's encoding, which is
 * exactly what it is not.
 *
 * Its own line rather than a suffix: appended to the tokenizer line it pushed
 * that line past 130 characters, and a report surface that wraps mid-sentence
 * is how a qualifier gets skipped.
 */
export function formatApproximationNote(tokenizer: TokenizerInfo, model: string): string | null {
  if (!tokenizer.approximated) {
    return null;
  }
  // Names the MODEL, not the tokenizer: the line this sits under already
  // prints the tokenizer, and a note that repeats the line above it reads as
  // decoration and gets skipped.
  return `  ^ approximate: no tokenizer is registered for ${model}, so the above is a substitute`;
}

/**
 * The line naming the gap between the breakdown's total and the assembled
 * context, or null when there is nothing to explain.
 *
 * Shared by every surface that prints `Total Tokens`, so a surface cannot show
 * that figure while omitting what it excludes — the analysis and visualization
 * displays both print it, and the next one to print it inherits this rather
 * than reimplementing it (mt#3458, PR #2777 R1).
 */
export function formatAssembledContextLine(summary: {
  totalTokens: number;
  assembledTokens: number;
}): string | null {
  if (summary.assembledTokens <= summary.totalTokens) {
    return null;
  }
  const headerTokens = summary.assembledTokens - summary.totalTokens;
  return (
    `Assembled Context: ${summary.assembledTokens.toLocaleString()} tokens ` +
    `(+${headerTokens.toLocaleString()} for the generation header, which is in no component)`
  );
}

/**
 * Resolve a model's context window from the model cache.
 *
 * Returns null when the model is not cached; callers render that as unknown.
 * Substituting a default instead is the defect this replaced — the previous
 * hardcoded table ended in a chain of `includes()` branches that handed every
 * unrecognized id a plausible number, so `claude-opus-5` matched none of them,
 * fell through to a 100,000 "conservative fallback", and reported a tenth of
 * its real 1,000,000-token window (mt#3390).
 *
 * Goes stale if: the cache is never populated, in which case every model reads
 * as unknown. The cache is written by provider calls (see
 * `refreshProviderModelsInBackground`); to populate it by hand run
 * `minsky ai models refresh`. This function deliberately does NOT refresh —
 * analysing a context must not make a network call as a side effect.
 *
 * The cache is partitioned by provider but this call site has only a bare model
 * id, so every provider is searched. Providers are visited in sorted order so
 * an id present under two providers resolves identically on every run.
 */
export async function getModelContextWindow(
  model: string,
  source: CachedModelLimitSource = new DefaultModelCacheService()
): Promise<number | null> {
  let cachedByProvider: Record<string, { id: string; contextWindow: number }[]>;

  try {
    cachedByProvider = await source.getAllCachedModels();
  } catch (error) {
    // An unreadable cache means the window is unknown, not that analysis
    // failed — the rest of the report is still worth producing.
    log.debug("Model cache unreadable; reporting context window as unknown", {
      model,
      error: getLoggableErrorSummary(error),
    });
    return null;
  }

  for (const provider of Object.keys(cachedByProvider).sort()) {
    const match = cachedByProvider[provider]?.find((cached) => cached.id === model);
    if (match && typeof match.contextWindow === "number") {
      return match.contextWindow;
    }
  }

  return null;
}

/**
 * Analyze the generated context for token usage and optimization opportunities
 */
export async function analyzeGeneratedContext(
  result: GenerateResult,
  options: GenerateOptions,
  /** Test seam; production callers omit it and get the real file-backed cache. */
  contextWindowSource?: CachedModelLimitSource
): Promise<AnalysisResult> {
  const tokenizationService = new DefaultTokenizationService();
  const targetModel = options.model || "gpt-4o";

  /**
   * Reuse the counts the generation path already produced when they were
   * produced for THIS model. Recomputing them here is what broke the breakdown
   * before mt#3458: the generation path estimated `token_count` at one token per
   * four characters while this loop measured the same text with the real
   * tokenizer, so every percentage divided a measurement by an estimate and the
   * total could be exceeded. Reusing makes numerator and denominator the same
   * numbers by construction, not by two paths agreeing.
   *
   * They can only diverge when the analysis targets a different model than the
   * generation did — `displayModelComparison` re-generates per model, so this
   * holds there too, but the guard is on the recorded model rather than on that
   * call-site convention.
   */
  const countsMatchThisModel = result.metadata.tokenizedForModel === targetModel;

  // Analyze each component's token usage
  const componentAnalysis: ComponentBreakdown[] = [];
  let recountedTotal = 0;
  for (const component of result.components) {
    const reusable = countsMatchThisModel ? component.token_count : undefined;
    const tokens =
      reusable ?? (await tokenizationService.countTokens(component.content, targetModel));
    recountedTotal += tokens;
    componentAnalysis.push({
      component: component.component_id,
      tokens,
      percentage: "0.0",
      content_length: component.content.length,
    });
  }

  /**
   * When the counts were recomputed for a different model, `metadata.totalTokens`
   * belongs to the generation model and is the wrong denominator — the sum of
   * what is actually displayed is the right one.
   */
  const totalTokens = countsMatchThisModel ? result.metadata.totalTokens : recountedTotal;

  for (const breakdown of componentAnalysis) {
    const percentage = totalTokens ? (breakdown.tokens / totalTokens) * 100 : 0;
    breakdown.percentage = percentage.toFixed(1);
  }

  // Sort by token usage (largest first)
  componentAnalysis.sort((a, b) => b.tokens - a.tokens);

  // Get model-specific context window size
  const contextWindowSize = contextWindowSource
    ? await getModelContextWindow(targetModel, contextWindowSource)
    : await getModelContextWindow(targetModel);

  /**
   * On the mismatch path every component was recounted for this model, so the
   * generation path's assembled figure belongs to a different tokenizer target
   * and would be the odd number out.
   */
  const assembledTokens = countsMatchThisModel
    ? result.metadata.assembledTokens
    : await tokenizationService.countTokens(result.content, targetModel);

  // Generate optimization suggestions
  const optimizations = generateContextOptimizations(componentAnalysis, totalTokens);

  const tokenizerInfo = await describeTokenizer(tokenizationService, targetModel);

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
      totalTokens,
      assembledTokens,
      totalComponents: result.components.length,
      averageTokensPerComponent: componentAnalysis.length
        ? Math.round(totalTokens / componentAnalysis.length)
        : 0,
      largestComponent: componentAnalysis[0]?.component || "none",
      /**
       * Utilization measures what an operator would actually send, so it uses
       * the assembled figure — the header is context they pay for. Before
       * mt#3458 this divided a chars/4 estimate by the window and understated
       * utilization by roughly the same ~20% the percentages overstated.
       */
      contextWindowUtilization:
        contextWindowSize === null ? null : (assembledTokens / contextWindowSize) * 100,
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
