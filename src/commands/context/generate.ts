/**
 * Context generate command implementation
 *
 * Generate AI context using modular components with optional analysis and visualization.
 */

import { Command } from "commander";
import { log } from "../../utils/logger.js";
import { TaskStatus } from "../../domain/tasks/taskConstants.js";
import {
  getContextComponentRegistry,
  registerDefaultComponents,
  getComponentHelp,
} from "../../domain/context/components/index.js";
import { DefaultTokenizationService } from "../../domain/ai/tokenization/index.js";

// Re-export types for backward compatibility
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

interface GenerateOptions {
  json?: boolean;
  components?: string;
  output?: string;
  template?: string;
  model?: string;
  prompt?: string;
  interface?: string;
  analyze?: boolean;
  analyzeOnly?: boolean;
  compareModels?: string;
  showBreakdown?: boolean;
  // Visualization options
  visualize?: boolean;
  visualizeOnly?: boolean;
  chartType?: string;
  maxWidth?: string;
  showDetails?: boolean;
  csv?: boolean;
}

export function createGenerateCommand(): Command {
  // Register default components
  registerDefaultComponents();

  // Get available components for help
  const componentHelp = getComponentHelp();
  const helpText = componentHelp.map((c) => `  ${c.id.padEnd(18)} ${c.description}`).join("\n");

  return (
    new Command("generate")
      .description("Generate AI context using modular components")
      .option("--json", "Output in JSON format", false)
      .option("-c, --components <components>", "Comma-separated list of component IDs to include")
      .option("-o, --output <file>", "Output file path (defaults to stdout)")
      .option("-t, --template <template>", "Use specific template for generation")
      .option("-m, --model <model>", "Target AI model for context generation", "gpt-4o")
      .option("-p, --prompt <prompt>", "User prompt to customize context generation")
      .option(
        "-i, --interface <interface>",
        "Interface mode for tool schemas (cli|mcp|hybrid)",
        "cli"
      )
      .option("--analyze", "Analyze the generated context for token usage and optimization", false)
      .option("--analyze-only", "Only show analysis without the full context content", false)
      .option("--compare-models <models>", "Comma-separated list of models to compare")
      .option("--show-breakdown", "Show detailed component breakdown in analysis", false)
      // Visualization options
      .option("--visualize", "Generate visual charts of token distribution", false)
      .option("--visualize-only", "Only show visualization without context or analysis", false)
      .option("--chart-type <type>", "Chart type: bar, pie, tree", "bar")
      .option("--max-width <width>", "Maximum chart width in characters", "80")
      .option("--show-details", "Show detailed breakdown of largest components", false)
      .option("--csv", "Output results in CSV format", false)
      .addHelpText(
        "after",
        `
Available Components:
${helpText}

Examples:
  minsky context generate
  minsky context generate --components environment,rules,tool-schemas --json
  minsky context generate --template cursor-style --model claude-3-5-sonnet
  minsky context generate --prompt "focus on authentication and security rules"
  minsky context generate --interface mcp  # Use XML format for tool schemas
  minsky context generate --analyze  # Generate context with token analysis
  minsky context generate --analyze-only  # Show only analysis without full context
  minsky context generate --model claude-3.5-sonnet --analyze  # Analyze with specific model
  
  # Visualization examples
  minsky context generate --visualize  # Generate context with bar chart
  minsky context generate --visualize-only --chart-type pie  # Only show pie chart
  minsky context generate --visualize --chart-type tree --show-details  # Tree view with details
  minsky context generate --compare-models gpt-4,claude-3-5-sonnet --visualize  # Compare models with charts
  minsky context generate --csv  # Output component data in CSV format
`
      )
      .action(async (options: GenerateOptions) => {
        try {
          await executeGenerate(options);
        } catch (error) {
          log.error("Failed to generate context", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          log.error(
            `Failed to generate context: ${error instanceof Error ? error.message : String(error)}`
          );
          process.exit(1);
        }
      })
  );
}

async function executeGenerate(options: GenerateOptions): Promise<void> {
  log.info("Starting context generation", { options });

  // Handle model comparison if requested
  if (options.compareModels) {
    const models = options.compareModels.split(",").map((m) => m.trim());
    await displayModelComparison(models, options);
    return;
  }

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

  // Create generation request
  const request: GenerateRequest = {
    components: requestedComponents,
    input: {
      environment: {
        os: `${process.platform} ${process.arch}`,
        shell: process.env.SHELL || "unknown",
      },
      workspacePath: process.cwd(),
      task: {
        id: "md#082",
        title: "Add Context Management Commands for Environment-Agnostic AI Collaboration",
        status: TaskStatus.IN_PROGRESS,
        description: "Implementing modular context component system for testbench development",
      },
      userQuery:
        options.prompt ||
        "Implementing context generate command and designing modular context components",
      userPrompt: options.prompt,
      targetModel: options.model || "gpt-4o",
      interfaceConfig: {
        interface: options.interface || "cli",
        mcpEnabled: options.interface === "mcp" || options.interface === "hybrid",
        preferMcp: options.interface === "mcp",
      },
    },
  };

  // Generate context
  const result = await generateContext(request);

  // Perform analysis if requested or needed for visualization
  let analysisResult = null;
  if (
    options.analyze ||
    options.analyzeOnly ||
    options.compareModels ||
    options.showBreakdown ||
    options.visualize ||
    options.visualizeOnly
  ) {
    analysisResult = await analyzeGeneratedContext(result, options);
  }

  // Output result based on options
  if (options.csv) {
    // CSV output
    if (analysisResult) {
      outputCSV(analysisResult);
    } else {
      throw new Error("CSV output requires analysis data. Use --analyze or --visualize flags.");
    }
  } else if (options.json) {
    // JSON output
    if (options.analyzeOnly && analysisResult) {
      // Only output analysis in JSON format
      log.cli(JSON.stringify(analysisResult, null, 2));
    } else if (options.visualizeOnly && analysisResult) {
      // Only output visualization data in JSON format
      const visualizationData = {
        analysis: analysisResult,
        visualizations: generateVisualizationData(analysisResult, options),
      };
      log.cli(JSON.stringify(visualizationData, null, 2));
    } else {
      const jsonOutput = {
        sections: result.components,
        metadata: result.metadata,
        ...(analysisResult && { analysis: analysisResult }),
      };
      log.cli(JSON.stringify(jsonOutput, null, 2));
    }
  } else {
    // Console output
    if (options.visualizeOnly) {
      // Only show visualization
      if (analysisResult) {
        displayContextVisualization(analysisResult, options);
      } else {
        log.cli("No analysis performed. Use --visualize-only to enable visualization.");
      }
    } else if (options.analyzeOnly) {
      // Only display analysis in human-readable format
      if (analysisResult) {
        displayAnalysisResults(analysisResult, options);
      } else {
        log.cli("No analysis performed. Use --analyze-only to enable analysis.");
      }
    } else {
      // Show context content
      log.cli(result.content);

      // Display analysis in human-readable format if requested
      if (analysisResult && options.analyze) {
        displayAnalysisResults(analysisResult, options);
      }

      // Display visualization if requested
      if (analysisResult && options.visualize) {
        displayContextVisualization(analysisResult, options);
      }
    }
  }

  log.info("Context generation completed", {
    totalTokens: result.metadata.totalTokens,
    componentsUsed: result.components.length,
    skipped: result.metadata.skipped,
    generationTime: result.metadata.generationTime,
  });
}

// ... rest of the existing functions remain the same ...

/**
 * Get default components to include
 */
function getDefaultComponents(): string[] {
  // REPLICATE Cursor's context structure exactly - include ALL sections
  return [
    "environment", // OS, shell, workspace path (replicate Cursor's environment section)
    "workspace-rules", // Project-specific behavioral rules
    "system-instructions", // Core AI behavior guidelines
    "communication", // Communication formatting guidelines
    "tool-calling-rules", // Tool calling rules and best practices
    "maximize-parallel-tool-calls", // Parallel tool execution optimization
    "maximize-context-understanding", // Context exploration guidelines
    "making-code-changes", // Code change implementation guidelines
    "code-citation-format", // Code citation format requirements
    "task-management", // Todo system and task tracking
    "tool-schemas", // Available tools and parameters
    "project-context", // Git status and repository info
    "session-context", // Current session state with task metadata
  ];
}

/**
 * Generate context using the modular component system
 */
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
      log.debug(`Generating component: ${component.id}`);

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

      log.debug(`Component ${component.id} generated successfully`, {
        tokens: tokenCount,
        length: output.content.length,
      });
    } catch (error) {
      const errorMsg = `Failed to generate component ${component.id}: ${error instanceof Error ? error.message : String(error)}`;
      log.error(errorMsg, { error });
      errors.push(errorMsg);
      skipped.push(component.id);
    }
  }

  const generationTime = Date.now() - startTime;
  const totalTokens = outputs.reduce((sum, o) => sum + (o.token_count || 0), 0);

  // Create combined text output
  let content: string;
  if (outputs.length > 0) {
    const sections = outputs.map((o) => o.content);
    content = [
      "# Generated AI Context",
      "",
      `Generated at: ${new Date().toISOString()}`,
      "",
      `Components: ${outputs.map((o) => o.component_id).join(", ")}`,
      "",
      `Template: ${request.input.targetModel ? "model-specific" : "default"}`,
      "",
      `Target Model: ${request.input.targetModel}`,
      "",
      `Interface: ${request.input.interfaceConfig?.interface || "cli"}`,
      "",
      ...sections,
    ].join("\n\n");
  } else {
    content = "# No Context Generated\n\nAll components failed to generate content.";
  }

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

/**
 * Get context window size for different models
 */
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

/**
 * Analyze the generated context for token usage and optimization opportunities
 */
async function analyzeGeneratedContext(result: GenerateResult, options: GenerateOptions) {
  const tokenizationService = new DefaultTokenizationService();
  const targetModel = options.model || "gpt-4o";

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

  // Generate optimization suggestions
  const optimizations = generateContextOptimizations(
    componentAnalysis,
    result.metadata.totalTokens || 0
  );

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
  };
}

/**
 * Generate optimization suggestions based on component analysis
 */
function generateContextOptimizations(componentAnalysis: any[], totalTokens: number) {
  const optimizations = [];

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

/**
 * Display analysis results in human-readable format
 */
function displayAnalysisResults(analysis: any, options: GenerateOptions) {
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

    for (const component of analysis.componentBreakdown) {
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

    for (const opt of analysis.optimizations) {
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

// === VISUALIZATION FUNCTIONS ===

function generateVisualizationData(analysisResult: any, options: GenerateOptions) {
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

function displayContextVisualization(analysisResult: any, options: GenerateOptions) {
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

async function displayModelComparison(models: string[], options: GenerateOptions) {
  log.cli("\n🔄 Cross-Model Comparison");
  log.cli("━".repeat(80));

  const requestedComponents = options.components
    ? options.components.split(",").map((c) => c.trim())
    : getDefaultComponents();

  const comparisons = [];

  for (const model of models) {
    try {
      // Create generation request for this model
      const request: GenerateRequest = {
        components: requestedComponents,
        input: {
          environment: {
            os: `${process.platform} ${process.arch}`,
            shell: process.env.SHELL || "unknown",
          },
          workspacePath: process.cwd(),
          task: {
            id: "mt#461",
            title: "Context Visualization Redesign",
            status: TaskStatus.IN_PROGRESS,
            description: "Implementing context visualization using new component architecture",
          },
          userQuery: options.prompt || "Generating context visualization analysis",
          userPrompt: options.prompt,
          targetModel: model.trim(),
          interfaceConfig: {
            interface: options.interface || "cli",
            mcpEnabled: options.interface === "mcp" || options.interface === "hybrid",
            preferMcp: options.interface === "mcp",
          },
        },
      };

      const result = await generateContext(request);
      const analysisResult = await analyzeGeneratedContext(result, {
        ...options,
        model: model.trim(),
      });
      comparisons.push({ model: model.trim(), result: analysisResult });
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

    // Show visualization for first model if requested
    if (options.visualize && comparisons.length > 0) {
      log.cli(`\n📊 Visualization for ${comparisons[0].model}`);
      displayContextVisualization(comparisons[0].result, options);
    }
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
