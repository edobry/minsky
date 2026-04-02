/**
 * Display and formatting functions for the generate command
 *
 * Handles human-readable output of analysis results and CSV export.
 */

import { log } from "../../utils/logger";
import type { GenerateOptions, AnalysisResult, ComponentBreakdown, OptimizationSuggestion } from "./generate-types";

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
      log.cli(
        `Tokenizer: ${analysis.metadata.tokenizer.name} (${analysis.metadata.tokenizer.encoding})`
      );
    }
    log.cli(`Context Window: ${analysis.metadata.contextWindowSize.toLocaleString()} tokens`);
    log.cli(`Generated: ${new Date(analysis.metadata.analysisTimestamp).toLocaleString()}`);
    log.cli("");
  }

  // Summary
  log.cli(`Total Tokens: ${analysis.summary.totalTokens.toLocaleString()}`);
  log.cli(`Total Components: ${analysis.summary.totalComponents}`);
  log.cli(`Context Window Utilization: ${analysis.summary.contextWindowUtilization.toFixed(1)}%`);
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
