import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { CommandGeneratorService } from "../../rules/command-generator";
import { CommandCategory, sharedCommandRegistry } from "../../../adapters/shared/command-registry";
import { z } from "zod";

/**
 * Convert a Zod schema to JSON Schema format like Cursor uses
 */
function zodToJsonSchema(zodSchema: z.ZodTypeAny): any {
  if (zodSchema instanceof z.ZodString) {
    return { type: "string" };
  } else if (zodSchema instanceof z.ZodNumber) {
    return { type: "number" };
  } else if (zodSchema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  } else if (zodSchema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(zodSchema._def.type),
    };
  } else if (zodSchema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: zodSchema._def.values,
    };
  } else if (zodSchema instanceof z.ZodUnion) {
    const types = zodSchema._def.options.map((option: z.ZodTypeAny) => zodToJsonSchema(option));
    // If it's a simple union of types, just use the first type for simplicity
    return types[0] || { type: "string" };
  } else if (zodSchema instanceof z.ZodOptional) {
    return zodToJsonSchema(zodSchema._def.innerType);
  } else if (zodSchema instanceof z.ZodDefault) {
    return zodToJsonSchema(zodSchema._def.innerType);
  } else {
    // Default to string for unknown types
    return { type: "string" };
  }
}

/**
 * Extract JSON Schema properties and required fields from command parameters
 */
function extractParameterSchemas(commandId: string): {
  properties: Record<string, any>;
  required: string[];
} {
  const command = sharedCommandRegistry.getCommand(commandId);
  if (!command || !command.parameters) {
    return { properties: {}, required: [] };
  }

  const properties: Record<string, any> = {};
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

      // Create command generator service with proper interface mode
      const commandGenerator = new CommandGeneratorService({
        interfaceMode: interfaceConfig.interface,
        mcpEnabled: interfaceConfig.mcpEnabled,
        preferMcp: interfaceConfig.preferMcp,
      });

      // Get all command categories and build comprehensive tool list
      const toolSchemas: Record<string, any> = {};
      const categories = [
        CommandCategory.TASKS,
        CommandCategory.SESSION,
        CommandCategory.SESSIONDB,
        CommandCategory.RULES,
        CommandCategory.GIT,
        CommandCategory.CONFIG,
        CommandCategory.DEBUG,
        CommandCategory.INIT,
      ];

      let totalTools = 0;
      for (const category of categories) {
        const commands = commandGenerator.getCommandsByCategory(category);
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

      return {
        toolSchemas,
        totalTools,
        interfaceMode: interfaceConfig.interface,
        shouldUseMcp:
          interfaceConfig.interface === "mcp" ||
          (interfaceConfig.interface === "hybrid" && interfaceConfig.preferMcp),
      };
    } catch (error) {
      console.warn("Failed to load tool schemas via template system:", error);
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
          tokenCount: content.length / 4,
          sections: ["tool_schemas"],
        },
      };
    }

    let content: string;

    if (inputs.shouldUseMcp) {
      // MCP/XML format for hybrid/mcp interface mode
      content = `Here are the functions available in JSONSchema format:
<functions>
${Object.entries(inputs.toolSchemas)
  .map(
    ([name, schema]) =>
      `<function>${JSON.stringify({ description: schema.description, name, parameters: schema.parameters }, null, 2)}</function>`
  )
  .join("\n")}
</functions>`;
    } else {
      // JSON format (default, matches Cursor exactly)
      content = `Here are the functions available in JSONSchema format:
${JSON.stringify(inputs.toolSchemas, null, 2)}`;
    }

    return {
      content,
      metadata: {
        componentId: "tool-schemas",
        tokenCount: content.length / 4,
        sections: ["functions"],
        totalTools: inputs.totalTools,
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
