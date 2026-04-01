/**
 * Context generate command implementation
 *
 * Generate AI context using modular components with optional analysis and visualization.
 */

import { Command } from "commander";
import { log } from "../../utils/logger";
import { TaskStatus } from "../../domain/tasks/taskConstants";
import {
  getContextComponentRegistry,
  registerDefaultComponents,
  getComponentHelp,
} from "../../domain/context/components/index";

import type { GenerateRequest, GenerateResult, GenerateOptions } from "./generate-types";
import { analyzeGeneratedContext } from "./generate-analysis";
import { displayAnalysisResults, outputCSV } from "./generate-display";
import { generateVisualizationData, displayContextVisualization } from "./generate-visualization";

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
  const request = buildGenerateRequest(requestedComponents, options);

  // Generate context
  const result = await generateContext(request);

  // Perform analysis if requested or needed for visualization
  let analysisResult: any = null;
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
  outputResults(result, analysisResult, options);

  log.info("Context generation completed", {
    totalTokens: result.metadata.totalTokens,
    componentsUsed: result.components.length,
    skipped: result.metadata.skipped,
    generationTime: result.metadata.generationTime,
  });
}

function buildGenerateRequest(components: string[], options: GenerateOptions): GenerateRequest {
  return {
    components,
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
}

function outputResults(
  result: GenerateResult,
  analysisResult: any,
  options: GenerateOptions
): void {
  if (options.csv) {
    if (analysisResult) {
      outputCSV(analysisResult);
    } else {
      throw new Error("CSV output requires analysis data. Use --analyze or --visualize flags.");
    }
  } else if (options.json) {
    outputJsonResults(result, analysisResult, options);
  } else {
    outputConsoleResults(result, analysisResult, options);
  }
}

function outputJsonResults(
  result: GenerateResult,
  analysisResult: any,
  options: GenerateOptions
): void {
  if (options.analyzeOnly && analysisResult) {
    log.cli(JSON.stringify(analysisResult, null, 2));
  } else if (options.visualizeOnly && analysisResult) {
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
}

function outputConsoleResults(
  result: GenerateResult,
  analysisResult: any,
  options: GenerateOptions
): void {
  if (options.visualizeOnly) {
    if (analysisResult) {
      displayAnalysisResults(analysisResult, options);
      displayContextVisualization(analysisResult, options);
    } else {
      log.cli("No analysis performed. Use --visualize-only to enable visualization.");
    }
  } else if (options.analyzeOnly) {
    if (analysisResult) {
      displayAnalysisResults(analysisResult, options);
      if (options.visualize) {
        displayContextVisualization(analysisResult, options);
      }
    } else {
      log.cli("No analysis performed. Use --analyze-only to enable analysis.");
    }
  } else {
    log.cli(result.content);
    if (analysisResult && options.analyze) {
      displayAnalysisResults(analysisResult, options);
    }
    if (analysisResult && options.visualize) {
      displayContextVisualization(analysisResult, options);
    }
  }
}

/**
 * Get default components to include
 */
function getDefaultComponents(): string[] {
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

      // Use new split architecture if available, fallback to legacy generate
      let output;
      if (component.gatherInputs && component.render) {
        const gatheredInputs = await component.gatherInputs(request.input);
        output = component.render(gatheredInputs, request.input);
      } else if (component.generate) {
        output = await component.generate(request.input);
      } else {
        throw new Error(`Component ${component.id} has no generation method`);
      }

      // Estimate token count (rough approximation: 1 token ~ 4 characters)
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

async function displayModelComparison(models: string[], options: GenerateOptions) {
  log.cli("\n🔄 Cross-Model Comparison");
  log.cli("━".repeat(80));

  const requestedComponents = options.components
    ? options.components.split(",").map((c) => c.trim())
    : getDefaultComponents();

  const comparisons: Array<{ model: string; result: any }> = [];

  for (const model of models) {
    try {
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

    if (options.visualize && comparisons.length > 0) {
      log.cli(`\n📊 Visualization for ${comparisons[0]!.model}`);
      displayContextVisualization(comparisons[0]!.result, options);
    }
  }
}
