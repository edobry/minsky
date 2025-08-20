import { Command } from "commander";
import { createLogger } from "../../utils/logger";
import { type ComponentInput } from "../../domain/context/components/types";
import {
  registerDefaultComponents,
  getAvailableComponentIds,
  getComponentHelp,
} from "../../domain/context/components/index";
import { getContextComponentRegistry } from "../../domain/context/components/registry";

const log = createLogger("context:generate");

interface GenerateOptions {
  format?: "text" | "json";
  components?: string[];
  output?: string;
  template?: string;
  model?: string;
  prompt?: string;
  interface?: "cli" | "mcp" | "hybrid";
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
    .option("-f, --format <format>", "Output format (text|json)", "text")
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
    .addHelpText(
      "after",
      `
Available Components:
${helpText}

Examples:
  minsky context generate
  minsky context generate --components environment,task-context --format json
  minsky context generate --template cursor-style --model claude-3-5-sonnet
  minsky context generate --prompt "focus on authentication and security rules"
  minsky context generate --interface mcp  # Use XML format for tool schemas
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

  // Output result
  if (options.format === "json") {
    const jsonOutput = {
      sections: result.components,
      metadata: result.metadata,
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    console.log(result.content);
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
