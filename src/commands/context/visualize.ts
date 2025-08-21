import { Command } from "commander";
import { logger } from "../../utils/logger.js";
import { ContextAnalysisService } from "../../domain/context/analysis-service.js";
import { ContextDiscoveryService } from "../../domain/context/discovery-service.js";
import { DefaultTokenizationService } from "../../domain/ai/tokenization/index.js";

export function createVisualizeCommand(): Command {
  const command = new Command("visualize");

  command
    .description("Generate visual representation of context usage")
    .option("-m, --model <model>", "Target model for analysis", "gpt-4o")
    .option("--compare-models <models>", "Comma-separated list of models to compare")
    .option("--compare-tokenizers", "Compare different tokenizers for the same content", false)
    .option("-w, --workspace-path <path>", "Specific workspace path to analyze")
    .option(
      "--include-types <types>",
      "Comma-separated list of element types to include (rule,file,metadata)"
    )
    .option("--exclude-types <types>", "Comma-separated list of element types to exclude")
    .option("--chart-type <type>", "Chart type: bar, pie, tree", "bar")
    .option("--max-width <width>", "Maximum chart width in characters", "80")
    .option("--show-details", "Show detailed breakdown of largest elements", false)
    .option("--json", "Output results in JSON format", false)
    .action(async (options) => {
      try {
        logger.info("🎨 Generating context visualization...");
        logger.info(`Target model: ${options.model}`);

        const discoveryService = new ContextDiscoveryService();
        const tokenizationService = new DefaultTokenizationService();
        const analysisService = new ContextAnalysisService(discoveryService, tokenizationService);

        // Parse include/exclude filters
        const includeTypes = options.includeTypes ? options.includeTypes.split(",") : null;
        const excludeTypes = options.excludeTypes ? options.excludeTypes.split(",") : null;

        // Discover and analyze context
        const analysisResult = await analysisService.analyzeContext({
          workspacePath: options.workspacePath,
          targetModel: options.model,
          includeTypes,
          excludeTypes,
        });

        if (options.json) {
          // JSON output with visualization data
          const visualizationData = {
            summary: analysisResult,
            visualizations: generateVisualizationData(analysisResult, options),
          };
          console.log(JSON.stringify(visualizationData, null, 2));
          return;
        }

        // Generate visual charts
        displayContextVisualization(analysisResult, options);

        // Handle model comparison if requested
        if (options.compareModels) {
          const models = options.compareModels.split(",");
          await displayModelComparison(analysisService, models, options);
        }

        // Handle tokenizer comparison if requested
        if (options.compareTokenizers) {
          await displayTokenizerComparison(analysisService, options);
        }

        logger.info(`\nVisualization completed in ${analysisResult.metadata.analysisTime}ms`);
      } catch (error) {
        logger.error(`Failed to generate context visualization: ${error}`);
        process.exit(1);
      }
    });

  // Add examples to help
  command.addHelpText(
    "after",
    `
Examples:
  minsky context visualize                           # Basic bar chart visualization
  minsky context visualize --chart-type pie         # Pie chart of token distribution
  minsky context visualize --compare-models gpt-4,claude-3-5-sonnet
  minsky context visualize --compare-tokenizers     # Compare tokenization methods
  minsky context visualize --show-details           # Show detailed breakdown
  minsky context visualize --max-width 120          # Wider charts
  minsky context visualize --json                   # JSON output for processing

Chart Types:
  bar      Horizontal bar chart showing token distribution
  pie      Pie chart showing percentage breakdown
  tree     Hierarchical tree view of context elements

The visualize command provides graphical representation of context composition
and token usage to help understand and optimize AI context effectiveness.
`
  );

  return command;
}

function generateVisualizationData(analysisResult: any, options: any) {
  const { chartType, maxWidth } = options;

  return {
    chartType,
    maxWidth: parseInt(maxWidth),
    elements: analysisResult.elements.map((element: any) => ({
      type: element.type,
      name: element.name,
      tokens: element.tokens,
      percentage: ((element.tokens / analysisResult.totalTokens) * 100).toFixed(1),
    })),
    typeBreakdown: analysisResult.typeBreakdown,
  };
}

function displayContextVisualization(analysisResult: any, options: any) {
  const { chartType, maxWidth, showDetails } = options;
  const width = parseInt(maxWidth);

  console.log("\n🎨 Context Visualization");
  console.log("━".repeat(Math.min(width, 80)));
  console.log(`Total Tokens: ${analysisResult.totalTokens.toLocaleString()}`);
  console.log(
    `Context Window Utilization: ${((analysisResult.totalTokens / 128000) * 100).toFixed(1)}%`
  );
  console.log(`Total Elements: ${analysisResult.elements.length}`);
  console.log(`Model: ${analysisResult.metadata.targetModel}`);

  switch (chartType) {
    case "bar":
      displayBarChart(analysisResult, width);
      break;
    case "pie":
      displayPieChart(analysisResult, width);
      break;
    case "tree":
      displayTreeView(analysisResult, width);
      break;
    default:
      displayBarChart(analysisResult, width);
  }

  if (showDetails) {
    displayDetailedBreakdown(analysisResult);
  }
}

function displayBarChart(analysisResult: any, width: number) {
  console.log("\n📊 Token Distribution (Bar Chart)");
  console.log("━".repeat(Math.min(width, 80)));

  // Group by type for cleaner visualization
  const typeBreakdown = analysisResult.typeBreakdown;
  const maxTokens = Math.max(...Object.values(typeBreakdown).map((t: any) => t.tokens));
  const barWidth = Math.min(width - 30, 50);

  Object.entries(typeBreakdown).forEach(([type, data]: [string, any]) => {
    const percentage = ((data.tokens / analysisResult.totalTokens) * 100).toFixed(1);
    const barLength = Math.round((data.tokens / maxTokens) * barWidth);
    const bar = "█".repeat(barLength) + "░".repeat(barWidth - barLength);

    console.log(
      `${type.padEnd(12)} │${bar}│ ${data.tokens.toLocaleString().padStart(8)} (${percentage}%)`
    );
  });
}

function displayPieChart(analysisResult: any, width: number) {
  console.log("\n🥧 Token Distribution (Pie Chart)");
  console.log("━".repeat(Math.min(width, 80)));

  const typeBreakdown = analysisResult.typeBreakdown;
  const segments = Object.entries(typeBreakdown).map(([type, data]: [string, any]) => ({
    type,
    tokens: data.tokens,
    percentage: (data.tokens / analysisResult.totalTokens) * 100,
  }));

  // Simple ASCII pie representation
  segments.forEach((segment) => {
    const segmentSize = Math.round(segment.percentage / 5); // Each ● represents ~5%
    const visual = "●".repeat(segmentSize) + "○".repeat(20 - segmentSize);
    console.log(
      `${segment.type.padEnd(12)} ${visual} ${segment.percentage.toFixed(1)}% (${segment.tokens.toLocaleString()} tokens)`
    );
  });
}

function displayTreeView(analysisResult: any, width: number) {
  console.log("\n🌳 Context Hierarchy (Tree View)");
  console.log("━".repeat(Math.min(width, 80)));

  const typeBreakdown = analysisResult.typeBreakdown;

  Object.entries(typeBreakdown).forEach(([type, data]: [string, any], index, array) => {
    const isLast = index === array.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const percentage = ((data.tokens / analysisResult.totalTokens) * 100).toFixed(1);

    console.log(
      `${connector}${type} (${data.count} elements, ${data.tokens.toLocaleString()} tokens, ${percentage}%)`
    );

    // Show top elements in each category
    const elements = analysisResult.elements
      .filter((el: any) => el.type === type)
      .sort((a: any, b: any) => b.tokens - a.tokens)
      .slice(0, 3);

    elements.forEach((element: any, elIndex: number) => {
      const isLastElement = elIndex === elements.length - 1;
      const elConnector = isLast
        ? isLastElement
          ? "    └── "
          : "    ├── "
        : isLastElement
          ? "│   └── "
          : "│   ├── ";
      const elPercentage = ((element.tokens / analysisResult.totalTokens) * 100).toFixed(1);
      console.log(
        `${elConnector}${element.name} (${element.tokens.toLocaleString()} tokens, ${elPercentage}%)`
      );
    });

    if (data.count > 3) {
      const remaining = data.count - 3;
      const remainingConnector = isLast ? "    └── " : "│   └── ";
      console.log(`${remainingConnector}... and ${remaining} more`);
    }
  });
}

function displayDetailedBreakdown(analysisResult: any) {
  console.log("\n📋 Detailed Element Breakdown");
  console.log("━".repeat(80));

  const topElements = analysisResult.elements
    .sort((a: any, b: any) => b.tokens - a.tokens)
    .slice(0, 10);

  topElements.forEach((element: any, index: number) => {
    const percentage = ((element.tokens / analysisResult.totalTokens) * 100).toFixed(2);
    console.log(`${(index + 1).toString().padStart(2)}. ${element.name}`);
    console.log(
      `    Type: ${element.type} | Tokens: ${element.tokens.toLocaleString()} (${percentage}%)`
    );
    console.log(`    Characters: ${element.characters.toLocaleString()}`);
    if (element.path) {
      console.log(`    Path: ${element.path}`);
    }
    console.log("");
  });
}

async function displayModelComparison(analysisService: any, models: string[], options: any) {
  console.log("\n🔄 Cross-Model Comparison");
  console.log("━".repeat(80));

  const comparisons = [];

  for (const model of models) {
    try {
      const result = await analysisService.analyzeContext({
        workspacePath: options.workspacePath,
        targetModel: model.trim(),
        includeTypes: options.includeTypes?.split(","),
        excludeTypes: options.excludeTypes?.split(","),
      });
      comparisons.push({ model: model.trim(), result });
    } catch (error) {
      console.log(`❌ Failed to analyze for ${model}: ${error}`);
    }
  }

  if (comparisons.length > 1) {
    // Display comparison table
    console.log(
      "Model".padEnd(20) +
        "Tokens".padStart(10) +
        "Elements".padStart(10) +
        "Efficiency".padStart(12)
    );
    console.log("-".repeat(52));

    comparisons.forEach(({ model, result }) => {
      const efficiency = (result.totalTokens / result.elements.length).toFixed(1);
      console.log(
        model.padEnd(20) +
          result.totalTokens.toLocaleString().padStart(10) +
          result.elements.length.toString().padStart(10) +
          `${efficiency} t/e`.padStart(12)
      );
    });
  }
}

async function displayTokenizerComparison(analysisService: any, options: any) {
  console.log("\n🔧 Tokenizer Comparison");
  console.log("━".repeat(80));

  // This would require extending the analysis service to support tokenizer comparison
  // For now, show a placeholder
  console.log("Tokenizer comparison feature coming soon...");
  console.log("This will compare gpt-tokenizer vs tiktoken for the same content.");
}
