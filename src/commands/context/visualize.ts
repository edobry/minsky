import { Command } from "commander";
import { log } from "../../utils/logger.js";
import {
  getContextComponentRegistry,
  registerDefaultComponents,
} from "../../domain/context/components/index.js";
import { DefaultTokenizationService } from "../../domain/ai/tokenization/index.js";

// Import types and functions from the generate command
interface GenerateRequest {
  components: string[];
  input: {
    environment: { os: string; shell: string };
    workspacePath: string;
    task: { id: string; title: string; status: string; description: string };
    userQuery: string;
    userPrompt?: string;
    targetModel: string;
    interfaceConfig: { interface: string; mcpEnabled: boolean; preferMcp: boolean };
  };
}

interface GenerateResult {
  content: string;
  components: Array<{
    component_id: string;
    content: string;
    generated_at: string;
    token_count?: number;
  }>;
  metadata: {
    generationTime: number;
    totalTokens: number;
    skipped: string[];
    errors: string[];
  };
}

interface VisualizeOptions {
  model?: string;
  compareModels?: string;
  components?: string;
  chartType?: string;
  maxWidth?: string;
  showDetails?: boolean;
  json?: boolean;
  csv?: boolean;
  workspacePath?: string;
  prompt?: string;
  interface?: string;
}

export function createVisualizeCommand(): Command {
  // Register default components
  registerDefaultComponents();

  const command = new Command("visualize");

  command
    .description("Generate visual representation of context token usage")
    .option("-m, --model <model>", "Target model for analysis", "gpt-4o")
    .option("--compare-models <models>", "Comma-separated list of models to compare")
    .option("-c, --components <components>", "Comma-separated list of component IDs to include")
    .option("--chart-type <type>", "Chart type: bar, pie, tree", "bar")
    .option("--max-width <width>", "Maximum chart width in characters", "80")
    .option("--show-details", "Show detailed breakdown of largest components", false)
    .option("--json", "Output results in JSON format", false)
    .option("--csv", "Output results in CSV format", false)
    .option("-w, --workspace-path <path>", "Specific workspace path to analyze")
    .option("-p, --prompt <prompt>", "User prompt to customize context generation")
    .option(
      "-i, --interface <interface>",
      "Interface mode for tool schemas (cli|mcp|hybrid)",
      "cli"
    )
    .action(async (options: VisualizeOptions) => {
      try {
        log.info("🎨 Generating context visualization...");
        log.info(`Target model: ${options.model}`);

        await executeVisualize(options);
      } catch (error) {
        log.error(`Failed to generate context visualization: ${error}`);
        log.error(
          `Failed to generate context visualization: ${error instanceof Error ? error.message : String(error)}`
        );
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
  minsky context visualize --chart-type tree        # Hierarchical tree view
  minsky context visualize --compare-models gpt-4,claude-3-5-sonnet
  minsky context visualize --components environment,rules,tool-schemas
  minsky context visualize --show-details           # Show detailed breakdown
  minsky context visualize --max-width 120          # Wider charts
  minsky context visualize --json                   # JSON output for processing
  minsky context visualize --csv                    # CSV output for spreadsheets

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

async function executeVisualize(options: VisualizeOptions): Promise<void> {
  // Determine which components to use
  const requestedComponents = options.components
    ? options.components.split(",").map((c) => c.trim())
    : getDefaultComponents();

  // Validate components exist
  const registry = getContextComponentRegistry();
  const validation = registry.validateComponents(requestedComponents);
  if (!validation.valid) {
    throw new Error(`Unknown components: ${validation.missing.join(", ")}`);
  }

  // Handle model comparison if requested
  if (options.compareModels) {
    const models = options.compareModels.split(",").map((m) => m.trim());
    await displayModelComparison(models, options);
    return;
  }

  // Generate and analyze context for single model
  const analysisResult = await generateAndAnalyze(
    options.model || "gpt-4o",
    requestedComponents,
    options
  );

  // Output results
  if (options.json) {
    const visualizationData = {
      analysis: analysisResult,
      visualizations: generateVisualizationData(analysisResult, options),
    };
    log.cli(JSON.stringify(visualizationData, null, 2));
  } else if (options.csv) {
    outputCSV(analysisResult);
  } else {
    displayContextVisualization(analysisResult, options);
  }

  log.info(`Visualization completed in ${analysisResult.metadata.generationTime}ms`);
}

async function generateAndAnalyze(model: string, components: string[], options: VisualizeOptions) {
  // Create generation request
  const request: GenerateRequest = {
    components,
    input: {
      environment: {
        os: `${process.platform} ${process.arch}`,
        shell: process.env.SHELL || "unknown",
      },
      workspacePath: options.workspacePath || process.cwd(),
      task: {
        id: "mt#461",
        title: "Context Visualization Redesign",
        status: "IN-PROGRESS",
        description: "Implementing context visualization using new component architecture",
      },
      userQuery: options.prompt || "Generating context visualization analysis",
      userPrompt: options.prompt,
      targetModel: model,
      interfaceConfig: {
        interface: options.interface || "cli",
        mcpEnabled: options.interface === "mcp" || options.interface === "hybrid",
        preferMcp: options.interface === "mcp",
      },
    },
  };

  // Generate context
  const result = await generateContext(request);

  // Analyze the generated context
  const analysisResult = await analyzeGeneratedContext(result, { model });

  return analysisResult;
}

// Import the generation and analysis functions from the generate command
// For now, we'll implement simplified versions based on the architecture

async function generateContext(request: GenerateRequest): Promise<GenerateResult> {
  const startTime = Date.now();
  const registry = getContextComponentRegistry();
  const components = registry.getWithDependencies(request.components);

  const outputs: Array<{
    component_id: string;
    content: string;
    generated_at: string;
    token_count?: number;
  }> = [];

  const skipped: string[] = [];
  const errors: string[] = [];

  // Process each component
  for (const component of components) {
    try {
      // Use new split architecture if available, fallback to legacy generate method
      let output;
      if (component.gatherInputs && component.render) {
        // New split architecture
        const gatheredInputs = await component.gatherInputs(request.input);
        output = component.render(gatheredInputs, request.input);
      } else if (component.generate) {
        // Legacy method
        output = await component.generate(request.input);
      } else {
        throw new Error(`Component ${component.id} has no generation method`);
      }

      // Estimate token count (rough approximation: 1 token ≈ 4 characters)
      const tokenCount = Math.floor(output.content.length / 4);

      outputs.push({
        component_id: component.id,
        content: output.content,
        generated_at: output.metadata?.generatedAt || new Date().toISOString(),
        token_count: tokenCount,
      });
    } catch (error) {
      const errorMsg = `Failed to generate component ${component.id}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      skipped.push(component.id);
    }
  }

  const generationTime = Date.now() - startTime;
  const totalTokens = outputs.reduce((sum, o) => sum + (o.token_count || 0), 0);

  // Create combined text output
  const sections = outputs.map((o) => o.content);
  const content = sections.join("\n\n");

  return {
    content,
    components: outputs,
    metadata: {
      generationTime,
      totalTokens,
      skipped,
      errors,
    },
  };
}

async function analyzeGeneratedContext(result: GenerateResult, options: { model: string }) {
  const tokenizationService = new DefaultTokenizationService();
  const targetModel = options.model;

  // Analyze each component's token usage
  const componentAnalysis = [];
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

  // Get tokenizer information
  const tokenizerInfo = tokenizationService.getTokenizerInfo?.(targetModel) || {
    name: "tiktoken",
    encoding: "cl100k_base",
    description: "OpenAI tokenizer",
  };

  return {
    metadata: {
      model: targetModel,
      tokenizer: tokenizerInfo,
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
  };
}

function getModelContextWindow(model: string): number {
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

function getDefaultComponents(): string[] {
  // Use the same defaults as the generate command
  return [
    "environment",
    "workspace-rules",
    "system-instructions",
    "communication",
    "tool-calling-rules",
    "maximize-parallel-tool-calls",
    "maximize-context-understanding",
    "making-code-changes",
    "code-citation-format",
    "task-management",
    "tool-schemas",
    "project-context",
    "session-context",
  ];
}

function generateVisualizationData(analysisResult: any, options: VisualizeOptions) {
  const { chartType, maxWidth } = options;

  return {
    chartType: chartType || "bar",
    maxWidth: parseInt(maxWidth || "80"),
    elements: analysisResult.componentBreakdown.map((component: any) => ({
      type: "component",
      name: component.component,
      tokens: component.tokens,
      percentage: component.percentage,
    })),
    typeBreakdown: {
      components: {
        count: analysisResult.componentBreakdown.length,
        tokens: analysisResult.summary.totalTokens,
      },
    },
  };
}

function displayContextVisualization(analysisResult: any, options: VisualizeOptions) {
  const { chartType, maxWidth, showDetails } = options;
  const width = parseInt(maxWidth || "80");

  log.cli("\n🎨 Context Visualization");
  log.cli("━".repeat(Math.min(width, 80)));
  log.cli(`Total Tokens: ${analysisResult.summary.totalTokens.toLocaleString()}`);
  log.cli(
    `Context Window Utilization: ${analysisResult.summary.contextWindowUtilization.toFixed(1)}%`
  );
  log.cli(`Total Components: ${analysisResult.summary.totalComponents}`);
  log.cli(`Model: ${analysisResult.metadata.model}`);

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
  log.cli("\n📊 Token Distribution (Bar Chart)");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;
  const maxTokens = Math.max(...components.map((c: any) => c.tokens));
  const barWidth = Math.min(width - 30, 50);

  components.forEach((component: any) => {
    const percentage = component.percentage;
    const barLength = Math.round((component.tokens / maxTokens) * barWidth);
    const bar = "█".repeat(barLength) + "░".repeat(barWidth - barLength);

    log.cli(
      `${component.component.padEnd(20)} │${bar}│ ${component.tokens.toLocaleString().padStart(8)} (${percentage}%)`
    );
  });
}

function displayPieChart(analysisResult: any, width: number) {
  log.cli("\n🥧 Token Distribution (Pie Chart)");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;

  // Simple ASCII pie representation
  components.forEach((component: any) => {
    const percentage = parseFloat(component.percentage);
    const segmentSize = Math.round(percentage / 5); // Each ● represents ~5%
    const visual = "●".repeat(segmentSize) + "○".repeat(20 - segmentSize);
    log.cli(
      `${component.component.padEnd(20)} ${visual} ${component.percentage}% (${component.tokens.toLocaleString()} tokens)`
    );
  });
}

function displayTreeView(analysisResult: any, width: number) {
  log.cli("\n🌳 Context Hierarchy (Tree View)");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;

  log.cli(`├── Context (${analysisResult.summary.totalTokens.toLocaleString()} tokens total)`);

  components.forEach((component: any, index: number) => {
    const isLast = index === components.length - 1;
    const connector = isLast ? "└── " : "├── ";
    log.cli(
      `${connector}${component.component} (${component.tokens.toLocaleString()} tokens, ${component.percentage}%)`
    );
  });
}

function displayDetailedBreakdown(analysisResult: any) {
  log.cli("\n📋 Detailed Component Breakdown");
  log.cli("━".repeat(80));

  const topComponents = analysisResult.componentBreakdown.slice(0, 10);

  topComponents.forEach((component: any, index: number) => {
    log.cli(`${(index + 1).toString().padStart(2)}. ${component.component}`);
    log.cli(`    Tokens: ${component.tokens.toLocaleString()} (${component.percentage}%)`);
    log.cli(`    Characters: ${component.content_length.toLocaleString()}`);
    log.cli("");
  });
}

async function displayModelComparison(models: string[], options: VisualizeOptions) {
  log.cli("\n🔄 Cross-Model Comparison");
  log.cli("━".repeat(80));

  const requestedComponents = options.components
    ? options.components.split(",").map((c) => c.trim())
    : getDefaultComponents();

  const comparisons = [];

  for (const model of models) {
    try {
      const result = await generateAndAnalyze(model.trim(), requestedComponents, options);
      comparisons.push({ model: model.trim(), result });
    } catch (error) {
      log.cli(`❌ Failed to analyze for ${model}: ${error}`);
    }
  }

  if (comparisons.length > 1) {
    // Display comparison table
    log.cli(
      "Model".padEnd(25) +
        "Tokens".padStart(10) +
        "Components".padStart(12) +
        "Utilization".padStart(12)
    );
    log.cli("-".repeat(59));

    comparisons.forEach(({ model, result }) => {
      const utilization = result.summary.contextWindowUtilization.toFixed(1);
      log.cli(
        model.padEnd(25) +
          result.summary.totalTokens.toLocaleString().padStart(10) +
          result.summary.totalComponents.toString().padStart(12) +
          `${utilization}%`.padStart(12)
      );
    });

    // Show component differences
    log.cli("\n📊 Component Comparison");
    log.cli("━".repeat(80));

    const allComponents = new Set();
    comparisons.forEach(({ result }) => {
      result.componentBreakdown.forEach((comp: any) => allComponents.add(comp.component));
    });

    Array.from(allComponents).forEach((componentName) => {
      log.cli(`\n${componentName}:`);
      comparisons.forEach(({ model, result }) => {
        const comp = result.componentBreakdown.find((c: any) => c.component === componentName);
        if (comp) {
          log.cli(
            `  ${model.padEnd(20)} ${comp.tokens.toLocaleString().padStart(8)} tokens (${comp.percentage}%)`
          );
        } else {
          log.cli(`  ${model.padEnd(20)}        0 tokens (0.0%)`);
        }
      });
    });
  }
}

function outputCSV(analysisResult: any) {
  log.cli("Component,Tokens,Percentage,ContentLength");
  analysisResult.componentBreakdown.forEach((component: any) => {
    log.cli(
      `${component.component},${component.tokens},${component.percentage},${component.content_length}`
    );
  });
}
