import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { CommandCategory, sharedCommandRegistry } from "../../../adapters/shared/command-registry";
import { z } from "zod";
import { createToolSimilarityService } from "../../tools/similarity/tool-similarity-service";
import { log } from "../../../utils/logger";

type JsonSchema = {
  type?: string;
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
};

/**
 * Convert a Zod schema to JSON Schema format like Cursor uses
 */
function zodToJsonSchema(zodSchema: z.ZodType): JsonSchema {
  // Use Zod v4 .type property for schema type identification
  const schemaType = (zodSchema as { type?: string }).type;

  switch (schemaType) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return {
        type: "array",
        items: zodToJsonSchema((zodSchema as z.ZodArray).element as z.ZodType),
      };
    case "enum":
      return {
        type: "string",
        enum: (zodSchema as z.ZodEnum).options as string[],
      };
    case "union": {
      const types = ((zodSchema as z.ZodUnion).options as z.ZodType[]).map((option) =>
        zodToJsonSchema(option)
      );
      // If it's a simple union of types, just use the first type for simplicity
      return types[0] || { type: "string" };
    }
    case "optional":
      return zodToJsonSchema((zodSchema as z.ZodOptional).unwrap() as z.ZodType);
    case "default":
      return zodToJsonSchema((zodSchema as z.ZodDefault).removeDefault() as z.ZodType);
    default:
      // Default to string for unknown types
      return { type: "string" };
  }
}

/**
 * Extract JSON Schema properties and required fields from command parameters
 */
function extractParameterSchemas(commandId: string): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const command = sharedCommandRegistry.getCommand(commandId);
  if (!command || !command.parameters) {
    return { properties: {}, required: [] };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [paramName, paramDef] of Object.entries(command.parameters)) {
    // Convert Zod schema to JSON Schema
    const jsonSchema = zodToJsonSchema(paramDef.schema);

    // Add description if available
    if (paramDef.description) {
      jsonSchema.description = paramDef.description;
    }

    // Add default value if available
    if (paramDef.defaultValue !== undefined) {
      jsonSchema.default = paramDef.defaultValue;
    }

    properties[paramName] = jsonSchema;

    // Add to required if marked as required
    if (paramDef.required) {
      required.push(paramName);
    }
  }

  return { properties, required };
}

/**
 * Tool Schemas Component
 *
 * Uses the proper template system logic to determine JSON vs XML format based on interface configuration.
 * Leverages CommandGeneratorService with proper interface mode for professional tool documentation.
 */
export const ToolSchemasComponent: ContextComponent = {
  id: "tool-schemas",
  name: "Complete Tool Schemas",
  description: "Complete tool definitions with descriptions and parameters using template system",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    try {
      // Use the proper interface configuration from shared inputs (same logic as template system)
      const interfaceConfig = context.interfaceConfig || {
        interface: "cli" as const,
        mcpEnabled: false,
        preferMcp: false,
      };

      // Use custom registry if provided (for testing), otherwise use shared registry.
      // Cast to a structural type that covers both sharedCommandRegistry and test doubles.
      const registry =
        (context.commandRegistry as {
          getAllCommands(): { id: string; description: string; syntax?: string }[];
          getCommandsByCategory(category: CommandCategory): {
            id: string;
            description: string;
            syntax?: string;
          }[];
        }) || sharedCommandRegistry;

      // Check if query-aware filtering should be applied
      const userQuery = context.userQuery || context.userPrompt;
      // IMPORTANT: When a custom commandRegistry is provided (e.g., in unit tests),
      // disable query-based filtering to ensure full registry visibility.
      // Also disable if no persistence provider is available (required for embedding lookup).
      let shouldFilterByQuery =
        Boolean(userQuery?.trim()) &&
        !context.commandRegistry &&
        Boolean(context.persistenceProvider);

      const toolSchemas: Record<string, unknown> = {};
      let totalTools = 0;
      let filteredBy: string | undefined;
      let originalToolCount: number | undefined;
      let reductionPercentage: number | undefined;

      if (shouldFilterByQuery) {
        try {
          // NEW: Query-aware tool filtering using ToolSimilarityService
          // persistenceProvider is guaranteed non-null here because shouldFilterByQuery
          // requires Boolean(context.persistenceProvider) to be true

          const toolSimilarityService = await createToolSimilarityService(
            {},

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            context.persistenceProvider!
          );

          const relevantTools = await toolSimilarityService.findRelevantTools({
            query: userQuery as string,
            limit: 20, // Configurable limit - default reduces from 50+ to 20 tools
            threshold: 0.1, // Low threshold to be inclusive while still filtering
          });

          // Build tool schemas for relevant tools only
          for (const relevantTool of relevantTools) {
            const { properties, required } = extractParameterSchemas(relevantTool.tool.id);

            if (interfaceConfig.interface === "cli") {
              toolSchemas[relevantTool.tool.id] = {
                description: relevantTool.tool.description,
                parameters: {
                  type: "object",
                  properties,
                  required,
                },
                // Optional: Include relevance metadata for debugging
                _relevance: {
                  score: relevantTool.relevanceScore,
                  reason: relevantTool.reason,
                },
              };
            } else {
              toolSchemas[relevantTool.tool.id] = {
                description: relevantTool.tool.description,
                parameters: {
                  type: "object",
                  properties,
                  required,
                },
                _relevance: {
                  score: relevantTool.relevanceScore,
                  reason: relevantTool.reason,
                },
              };
            }
            totalTools++;
          }

          // Calculate reduction metrics
          const allCommands = registry.getAllCommands();
          originalToolCount = allCommands.length;
          reductionPercentage =
            originalToolCount > 0
              ? Math.round(((originalToolCount - totalTools) / originalToolCount) * 100)
              : 0;
          filteredBy = "user-query";
        } catch (error) {
          log.warn(
            `Failed to apply query-aware tool filtering, falling back to all tools: ${error instanceof Error ? error.message : String(error)}`
          );
          // Fall back to including all tools if filtering fails
          shouldFilterByQuery = false;
        }
      }

      if (!shouldFilterByQuery) {
        // Original logic: Get all command categories and build comprehensive tool list
        const categories = [
          CommandCategory.TASKS,
          CommandCategory.SESSION,
          CommandCategory.RULES,
          CommandCategory.GIT,
          CommandCategory.CONFIG,
          CommandCategory.DEBUG,
          CommandCategory.INIT,
          CommandCategory.AI,
        ];

        for (const category of categories) {
          const commands = registry.getCommandsByCategory(category);
          for (const cmd of commands) {
            // Extract actual parameter schemas from the shared command registry
            const { properties, required } = extractParameterSchemas(cmd.id);

            // For JSON format (default), use clean tool schema format like Cursor
            if (interfaceConfig.interface === "cli") {
              toolSchemas[cmd.id] = {
                description: cmd.description,
                parameters: {
                  type: "object",
                  properties,
                  required,
                },
              };
            } else {
              // For MCP mode, include full command representation
              toolSchemas[cmd.id] = {
                description: cmd.description,
                syntax: cmd.syntax,
                parameters: {
                  type: "object",
                  properties,
                  required,
                },
              };
            }
            totalTools++;
          }
        }
        filteredBy = "all-tools";
      }

      return {
        toolSchemas,
        totalTools,
        interfaceMode: interfaceConfig.interface,
        shouldUseMcp:
          interfaceConfig.interface === "mcp" ||
          (interfaceConfig.interface === "hybrid" && interfaceConfig.preferMcp),
        // New: Include filtering metadata
        filteredBy,
        originalToolCount,
        reductionPercentage,
        queryUsed: userQuery,
      };
    } catch (error) {
      log.warn(
        `Failed to load tool schemas via template system: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        toolSchemas: {},
        totalTools: 0,
        error: "Failed to load tool schemas",
        interfaceMode: "cli",
        shouldUseMcp: false,
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    if (inputs.error) {
      const content = `## Complete Tool Schemas

Error loading tool schemas: ${inputs.error}

Available tools could not be determined.`;

      return {
        content,
        metadata: {
          componentId: "tool-schemas",
          generatedAt: new Date().toISOString(),
          tokenCount: content.length / 4,
          sections: ["tool_schemas"],
        },
      };
    }

    // Prepare tool schemas without internal metadata for output
    const cleanToolSchemas: Record<string, unknown> = {};
    for (const [toolId, schema] of Object.entries(inputs.toolSchemas as Record<string, unknown>)) {
      // Remove internal _relevance metadata for clean output
      const { _relevance, ...cleanSchema } = schema as Record<string, unknown>;
      cleanToolSchemas[toolId] = cleanSchema;
    }

    let content: string;

    if (inputs.shouldUseMcp) {
      // MCP/XML format for hybrid/mcp interface mode
      content = `Here are the functions available in JSONSchema format:
<functions>
${Object.entries(cleanToolSchemas)
  .map(([name, schema]) => {
    const s = schema as Record<string, unknown>;
    return `<function>${JSON.stringify({ description: s.description, name, parameters: s.parameters }, null, 2)}</function>`;
  })
  .join("\n")}
</functions>`;
    } else {
      // JSON format (default, matches Cursor exactly)
      content = `Here are the functions available in JSONSchema format:
${JSON.stringify(cleanToolSchemas, null, 2)}`;
    }

    // Add filtering information as comment when query filtering was applied
    if (inputs.filteredBy === "user-query" && inputs.queryUsed) {
      const filteringSummary = `

<!-- Context-Aware Tool Filtering Applied -->
<!-- Query: "${inputs.queryUsed}" -->
<!-- Tools: ${inputs.totalTools} selected from ${inputs.originalToolCount} total (${inputs.reductionPercentage}% reduction) -->
<!-- This reduces context pollution while providing relevant tools for your query -->`;

      content += filteringSummary;
    }

    return {
      content,
      metadata: {
        componentId: "tool-schemas",
        generatedAt: new Date().toISOString(),
        tokenCount: content.length / 4,
        sections: ["functions"],
        totalTools: inputs.totalTools,
        // Include filtering metadata in component metadata
        filteredBy: inputs.filteredBy,
        originalToolCount: inputs.originalToolCount,
        reductionPercentage: inputs.reductionPercentage,
        queryUsed: inputs.queryUsed,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs, input);
  },
};

export function createToolSchemasComponent(): ContextComponent {
  return ToolSchemasComponent;
}
