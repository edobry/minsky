/**
 * Display and formatting functions for the generate command
 *
 * Handles human-readable output of analysis results and CSV export.
 */

import { log } from "@minsky/shared/logger";
import {
  APPROXIMATED_TOKENIZER_NOTE,
  formatAssembledContextLine,
  formatContextWindowSize,
  formatContextWindowUtilization,
} from "./generate-analysis";
import type {
  GenerateOptions,
  AnalysisResult,
  ComponentBreakdown,
  OptimizationSuggestion,
} from "./generate-types";

/**
 * Display analysis results in human-readable format
 */
export function displayAnalysisResults(analysis: AnalysisResult, options: GenerateOptions) {
  log.cli("\n🔍 Context Analysis");
  log.cli("━".repeat(50));

  // Model and tokenizer metadata
  if (analysis.metadata) {
    log.cli(`Model: ${analysis.metadata.model}`);
    log.cli(`Interface Mode: ${analysis.metadata.interface}`);
    if (analysis.metadata.tokenizer) {
      // Naming the approximation here is the whole point: an unlabelled
      // `o200k_base` beside an Anthropic model reads as that model's
      // tokenizer, which it is not (mt#3928).
      log.cli(
        `Tokenizer: ${analysis.metadata.tokenizer.name} (${analysis.metadata.tokenizer.encoding})`
      );
      if (analysis.metadata.tokenizer.approximated) {
        log.cli(APPROXIMATED_TOKENIZER_NOTE);
      }
    }
    log.cli(`Context Window: ${formatContextWindowSize(analysis.metadata.contextWindowSize)}`);
    log.cli(`Generated: ${new Date(analysis.metadata.analysisTimestamp).toLocaleString()}`);
    log.cli("");
  }

  // Summary
  log.cli(`Total Tokens: ${analysis.summary.totalTokens.toLocaleString()}`);
  /**
   * The assembly header belongs to no component, so it is absent from the
   * breakdown's denominator. Naming the difference is what keeps `Total Tokens`
   * from silently disagreeing with the context an operator actually sends
   * (mt#3458) — the breakdown below sums to `Total Tokens`, not to this.
   */
  const assembledLine = formatAssembledContextLine(analysis.summary);
  if (assembledLine) {
    log.cli(assembledLine);
  }
  log.cli(`Total Components: ${analysis.summary.totalComponents}`);
  log.cli(
    `Context Window Utilization: ${formatContextWindowUtilization(analysis.summary.contextWindowUtilization)}`
  );
  log.cli(`Largest Component: ${analysis.summary.largestComponent}`);

  // Component breakdown - always show when analyzing
  if (analysis.componentBreakdown.length > 0) {
    log.cli("\n📊 Component Breakdown");
    log.cli("━".repeat(50));

    for (const component of analysis.componentBreakdown as ComponentBreakdown[]) {
      log.cli(
        `${component.component.padEnd(20)} ${component.tokens.toLocaleString().padStart(8)} tokens (${component.percentage}%)`
      );
    }
  }

  // Model comparison removed

  // Optimization suggestions
  if (analysis.optimizations && analysis.optimizations.length > 0) {
    log.cli("\n💡 Optimization Suggestions");
    log.cli("━".repeat(50));

    for (const opt of analysis.optimizations as OptimizationSuggestion[]) {
      const icon =
        opt.type === "reduce"
          ? "🔽"
          : opt.type === "review"
            ? "👀"
            : opt.type === "optimize"
              ? "⚡"
              : "⚠️";
      log.cli(`${icon} ${opt.component}`);
      log.cli(`   ${opt.suggestion}`);
      log.cli(`   Potential savings: ${opt.potentialSavings.toLocaleString()} tokens`);
      log.cli("");
    }
  }
}

/**
 * Output analysis results in CSV format
 */
export function outputCSV(analysisResult: AnalysisResult) {
  log.cli("Component,Tokens,Percentage,ContentLength");
  analysisResult.componentBreakdown.forEach((component: ComponentBreakdown) => {
    log.cli(
      `${component.component},${component.tokens},${component.percentage},${component.content_length}`
    );
  });
}
