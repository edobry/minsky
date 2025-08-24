import { Command } from "commander";
import { createLogger } from "../../utils/logger";
import { type ComponentInput } from "../../domain/context/components/types";
import {
  registerDefaultComponents,
  getAvailableComponentIds,
  getComponentHelp,
} from "../../domain/context/components/index";
import { getContextComponentRegistry } from "../../domain/context/components/registry";
import { DefaultTokenizationService } from "../../domain/ai/tokenization/index";

const log = createLogger("context:generate");

interface GenerateOptions {
  json?: boolean;
  components?: string[];
  output?: string;
  template?: string;
  model?: string;
  prompt?: string;
  interface?: "cli" | "mcp" | "hybrid";
  analyze?: boolean;
  analyzeOnly?: boolean;
}

interface GenerateRequest {
  components: string[];
  input: ComponentInput;
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
    totalTokens?: number;
    skipped: string[];
    errors: string[];
  };
}

export function createGenerateCommand(): Command {
  // Register default components
  registerDefaultComponents();

  // Get available components for help
  const componentHelp = getComponentHelp();
  const helpText = componentHelp.map((c) => `  ${c.id.padEnd(18)} ${c.description}`).join("\n");

  return new Command("generate")
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
        console.error(
          `Failed to generate context: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    });
}

async function executeGenerate(options: GenerateOptions): Promise<void> {
  log.info("Starting context generation", { options });

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
        status: "IN-PROGRESS",
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

  // Perform analysis if requested
  let analysisResult = null;
  if (options.analyze || options.analyzeOnly || options.compareModels || options.showBreakdown) {
    analysisResult = await analyzeGeneratedContext(result, options);
  }

  // Output result
  if (options.json) {
    if (options.analyzeOnly && analysisResult) {
      // Only output analysis in JSON format
      console.log(JSON.stringify(analysisResult, null, 2));
    } else {
      const jsonOutput = {
        sections: result.components,
        metadata: result.metadata,
        ...(analysisResult && { analysis: analysisResult }),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
    }
  } else {
    if (options.analyzeOnly) {
      // Only display analysis in human-readable format
      if (analysisResult) {
        displayAnalysisResults(analysisResult, options);
      } else {
        console.log("No analysis performed. Use --analyze-only to enable analysis.");
      }
    } else {
      console.log(result.content);

      // Display analysis in human-readable format
      if (analysisResult) {
        displayAnalysisResults(analysisResult, options);
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
    description: "OpenAI tokenizer"
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
    // Suggest optimizing very large components
    if (component.tokens > 10000) {
      optimizations.push({
        type: "reduce",
        component: component.component,
        currentTokens: component.tokens,
        suggestion: `Component "${component.component}" is very large (${component.tokens} tokens, ${component.percentage}% of context). Consider reducing its scope or splitting it.`,
        confidence: "high",
        potentialSavings: Math.floor(component.tokens * 0.3),
      });
    }

    // Suggest reviewing components that are >20% of context
    if (parseFloat(component.percentage) > 20) {
      optimizations.push({
        type: "review",
        component: component.component,
        currentTokens: component.tokens,
        suggestion: `Component "${component.component}" consumes ${component.percentage}% of your context. Verify this is necessary for your use case.`,
        confidence: "medium",
        potentialSavings: component.tokens,
      });
    }
  }

  // Context window utilization warning
  const utilization = (totalTokens / 128000) * 100;
  if (utilization > 80) {
    optimizations.push({
      type: "restructure",
      component: "overall",
      currentTokens: totalTokens,
      suggestion: `High context utilization (${utilization.toFixed(1)}%). Consider using fewer components or reducing component scope.`,
      confidence: "high",
      potentialSavings: Math.floor(totalTokens * 0.2),
    });
  }

  return optimizations.slice(0, 5); // Limit to top 5 suggestions
}

/**
 * Display analysis results in human-readable format
 */
function displayAnalysisResults(analysis: any, options: GenerateOptions) {
  console.log("\n🔍 Context Analysis");
  console.log("━".repeat(50));

  // Model and tokenizer metadata
  if (analysis.metadata) {
    console.log(`Model: ${analysis.metadata.model}`);
    console.log(`Interface Mode: ${analysis.metadata.interface}`);
    if (analysis.metadata.tokenizer) {
      console.log(`Tokenizer: ${analysis.metadata.tokenizer.name} (${analysis.metadata.tokenizer.encoding})`);
    }
    console.log(`Context Window: ${analysis.metadata.contextWindowSize.toLocaleString()} tokens`);
    console.log(`Generated: ${new Date(analysis.metadata.analysisTimestamp).toLocaleString()}`);
    console.log("");
  }

  // Summary
  console.log(`Total Tokens: ${analysis.summary.totalTokens.toLocaleString()}`);
  console.log(`Total Components: ${analysis.summary.totalComponents}`);
  console.log(
    `Context Window Utilization: ${analysis.summary.contextWindowUtilization.toFixed(1)}%`
  );
  console.log(`Largest Component: ${analysis.summary.largestComponent}`);

  // Component breakdown - always show when analyzing
  if (analysis.componentBreakdown.length > 0) {
    console.log("\n📊 Component Breakdown");
    console.log("━".repeat(50));

    for (const component of analysis.componentBreakdown) {
      console.log(
        `${component.component.padEnd(20)} ${component.tokens.toLocaleString().padStart(8)} tokens (${component.percentage}%)`
      );
    }
  }

  // Model comparison removed

  // Optimization suggestions
  if (analysis.optimizations && analysis.optimizations.length > 0) {
    console.log("\n💡 Optimization Suggestions");
    console.log("━".repeat(50));

    for (const opt of analysis.optimizations) {
      const icon = opt.type === "reduce" ? "🔽" : opt.type === "review" ? "👀" : "⚠️";
      console.log(`${icon} ${opt.component}`);
      console.log(`   ${opt.suggestion}`);
      console.log(`   Potential savings: ${opt.potentialSavings.toLocaleString()} tokens`);
      console.log("");
    }
  }
}
