/**
 * Context Analyze Command
 *
 * Analyzes current context composition and provides token usage metrics,
 * optimization suggestions, and cross-model comparisons.
 */

import { Command } from "commander";
import chalk from "chalk";
import { createTokenizationService } from "../../domain/ai/tokenization";
import { ContextAnalysisService } from "../../domain/context/analysis-service";
import type { ContextAnalysisRequest } from "../../domain/context/types";
import { log } from "../../utils/logger";

interface AnalyzeOptions {
  model?: string;
  compareModels?: string;
  compareTokenizers?: boolean;
  includeOptimizations?: boolean;
  workspacePath?: string;
  includeTypes?: string;
  excludeTypes?: string;
  json?: boolean;
  detailed?: boolean;
}

/**
 * Create the context analyze command
 */
export function createAnalyzeCommand(): Command {
  return new Command("analyze")
    .description("Analyze current context composition and token usage")
    .option("-m, --model <model>", "Target model for analysis", "gpt-4o")
    .option("--compare-models <models>", "Comma-separated list of models to compare")
    .option("--compare-tokenizers", "Compare different tokenizers for the same content", false)
    .option("--include-optimizations", "Include optimization suggestions", false)
    .option("-w, --workspace-path <path>", "Specific workspace path to analyze")
    .option(
      "--include-types <types>",
      "Comma-separated list of element types to include (rule,file,metadata)"
    )
    .option("--exclude-types <types>", "Comma-separated list of element types to exclude")
    .option("--json", "Output results in JSON format", false)
    .option("--detailed", "Show detailed breakdown of all elements", false)
    .addHelpText(
      "after",
      `
Examples:
  minsky context analyze                           # Basic analysis with gpt-4o
  minsky context analyze -m claude-3-5-sonnet     # Analyze for Claude model
  minsky context analyze --compare-models gpt-4,gpt-3.5-turbo,claude-3-5-sonnet
  minsky context analyze --compare-tokenizers     # Compare tokenization methods
  minsky context analyze --include-optimizations  # Include optimization suggestions
  minsky context analyze --exclude-types file     # Only analyze rules and metadata
  minsky context analyze --json                   # JSON output for processing

The analyze command discovers context elements (rules, files, metadata) in your
workspace and provides detailed token usage analysis with local tokenization.
`
    )
    .action(async (options: AnalyzeOptions) => {
      try {
        await executeAnalyze(options);
      } catch (error) {
        log.error("Context analysis failed", { error });
        console.error(chalk.red(`❌ Context analysis failed: ${error}`));
        process.exit(1);
      }
    });
}

/**
 * Execute the context analyze command
 */
async function executeAnalyze(options: AnalyzeOptions): Promise<void> {
  const startTime = Date.now();

  // Initialize services
  const tokenizationService = createTokenizationService();
  const analysisService = new ContextAnalysisService(tokenizationService);

  // Build analysis request
  const request: ContextAnalysisRequest = {
    model: options.model || "gpt-4o",
    workspacePath: options.workspacePath,
    includeTypes: options.includeTypes?.split(",") as any,
    excludeTypes: options.excludeTypes?.split(",") as any,
    options: {
      compareModels: options.compareModels?.split(","),
      compareTokenizers: options.compareTokenizers,
      includeOptimizations: options.includeOptimizations,
      detailedBreakdown: options.detailed,
    },
  };

  if (!options.json) {
    console.log(chalk.blue("🔍 Analyzing context composition..."));
    console.log(chalk.dim(`Target model: ${request.model}`));
    if (request.workspacePath) {
      console.log(chalk.dim(`Workspace: ${request.workspacePath}`));
    }
    console.log();
  }

  // Perform analysis
  const result = await analysisService.analyzeContext(request);

  if (options.json) {
    // JSON output
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  displayResults(result, options);

  const totalTime = Date.now() - startTime;
  console.log();
  console.log(chalk.dim(`Analysis completed in ${totalTime}ms`));
}

/**
 * Display analysis results in human-readable format
 */
function displayResults(result: any, options: AnalyzeOptions): void {
  const { summary, breakdown, elements, modelComparison, tokenizerComparison, optimizations } =
    result;

  // Summary
  console.log(chalk.bold("📊 Context Analysis Summary"));
  console.log(chalk.dim("━".repeat(50)));
  console.log(`${chalk.bold("Total Tokens:")} ${chalk.cyan(summary.totalTokens.toLocaleString())}`);
  console.log(
    `${chalk.bold("Context Window Utilization:")} ${chalk.cyan(summary.utilizationPercentage.toFixed(1))}%`
  );
  console.log(`${chalk.bold("Total Elements:")} ${chalk.cyan(summary.totalElements)}`);
  console.log(
    `${chalk.bold("Total Characters:")} ${chalk.cyan(summary.totalCharacters.toLocaleString())}`
  );
  console.log(`${chalk.bold("Model:")} ${chalk.cyan(summary.model)}`);
  console.log();

  // Utilization warning
  if (summary.utilizationPercentage > 80) {
    console.log(chalk.yellow("⚠️  High context utilization - consider optimization"));
    console.log();
  }

  // Breakdown by type
  if (Object.keys(breakdown).length > 0) {
    console.log(chalk.bold("📋 Breakdown by Type"));
    console.log(chalk.dim("━".repeat(50)));

    for (const [type, stats] of Object.entries(breakdown)) {
      if (!stats) continue;
      const typeStats = stats as any;
      console.log(`${chalk.bold(capitalize(type))}:`);
      console.log(`  Count: ${chalk.cyan(typeStats.count)}`);
      console.log(
        `  Tokens: ${chalk.cyan(typeStats.tokens.toLocaleString())} (${chalk.cyan(typeStats.percentage.toFixed(1))}%)`
      );
      console.log(`  Characters: ${chalk.cyan(typeStats.characters.toLocaleString())}`);
      if (typeStats.largestElement) {
        console.log(
          `  Largest: ${chalk.dim(typeStats.largestElement.name)} (${chalk.cyan(typeStats.largestElement.tokens)} tokens)`
        );
      }
      console.log();
    }
  }

  // Top elements (if detailed or small number)
  if (options.detailed || elements.length <= 10) {
    console.log(chalk.bold("📄 Elements Analysis"));
    console.log(chalk.dim("━".repeat(50)));

    const elementsToShow = options.detailed ? elements : elements.slice(0, 5);

    for (const { element, tokenCount, percentage, ranking } of elementsToShow) {
      const typeIcon = getTypeIcon(element.type);
      console.log(`${chalk.bold(`#${ranking}`)} ${typeIcon} ${chalk.cyan(element.name)}`);
      console.log(
        `    Tokens: ${chalk.cyan(tokenCount.toLocaleString())} (${chalk.cyan(percentage.toFixed(1))}%)`
      );
      console.log(`    Characters: ${chalk.dim(element.size.characters.toLocaleString())}`);
      if (element.metadata?.filePath) {
        console.log(`    Path: ${chalk.dim(element.metadata.filePath)}`);
      }
      console.log();
    }

    if (!options.detailed && elements.length > 5) {
      console.log(chalk.dim(`... and ${elements.length - 5} more elements`));
      console.log(chalk.dim("Use --detailed to see all elements"));
      console.log();
    }
  }

  // Model comparison
  if (modelComparison?.length) {
    console.log(chalk.bold("🔄 Model Comparison"));
    console.log(chalk.dim("━".repeat(50)));

    for (const comparison of modelComparison) {
      const diffColor =
        comparison.difference > 0 ? chalk.red : comparison.difference < 0 ? chalk.green : chalk.dim;
      const diffSymbol = comparison.difference > 0 ? "+" : "";

      console.log(
        `${chalk.cyan(comparison.model)}: ${chalk.cyan(comparison.tokenCount.toLocaleString())} tokens`
      );
      console.log(
        `  Difference: ${diffColor(`${diffSymbol}${comparison.difference.toLocaleString()}`)} (${diffColor(`${diffSymbol}${comparison.differencePercentage.toFixed(1)}%`)})`
      );
    }
    console.log();
  }

  // Tokenizer comparison
  if (tokenizerComparison?.length) {
    console.log(chalk.bold("🔧 Tokenizer Comparison"));
    console.log(chalk.dim("━".repeat(50)));

    for (const comparison of tokenizerComparison) {
      const statusIcon = comparison.success ? chalk.green("✓") : chalk.red("✗");
      console.log(
        `${statusIcon} ${chalk.cyan(comparison.tokenizer.name)} (${comparison.tokenizer.library})`
      );
      if (comparison.success) {
        console.log(`  Tokens: ${chalk.cyan(comparison.tokenCount.toLocaleString())}`);
        console.log(`  Duration: ${chalk.dim(`${comparison.duration}ms`)}`);
      } else {
        console.log(`  Error: ${chalk.red(comparison.error)}`);
      }
    }
    console.log();
  }

  // Optimizations
  if (optimizations?.length) {
    console.log(chalk.bold("💡 Optimization Suggestions"));
    console.log(chalk.dim("━".repeat(50)));

    for (const opt of optimizations) {
      const typeIcon = getOptimizationIcon(opt.type);
      const confidenceColor =
        opt.confidence === "high"
          ? chalk.green
          : opt.confidence === "medium"
            ? chalk.yellow
            : chalk.dim;

      console.log(`${typeIcon} ${chalk.cyan(opt.elementName)}`);
      console.log(`  ${opt.description}`);
      console.log(`  Current: ${chalk.cyan(opt.currentTokens.toLocaleString())} tokens`);
      console.log(
        `  Potential savings: ${chalk.green(opt.potentialSavings.toLocaleString())} tokens`
      );
      console.log(`  Confidence: ${confidenceColor(opt.confidence)}`);
      console.log();
    }
  }

  // Performance metrics
  if (result.performance) {
    console.log(chalk.bold("⚡ Performance"));
    console.log(chalk.dim("━".repeat(50)));
    console.log(`Discovery: ${chalk.dim(`${result.performance.discoveryTime}ms`)}`);
    console.log(`Tokenization: ${chalk.dim(`${result.performance.tokenizationTime}ms`)}`);
    console.log(`Total: ${chalk.dim(`${result.performance.analysisTime}ms`)}`);
  }
}

/**
 * Get icon for element type
 */
function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    rule: "📏",
    file: "📄",
    metadata: "ℹ️",
    conversation: "💬",
    other: "📦",
  };
  return icons[type] || "📦";
}

/**
 * Get icon for optimization type
 */
function getOptimizationIcon(type: string): string {
  const icons: Record<string, string> = {
    remove: "🗑️",
    reduce: "✂️",
    optimize: "⚡",
    reorder: "🔄",
  };
  return icons[type] || "💡";
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
