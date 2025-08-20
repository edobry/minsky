import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Tool Schemas Component
 *
 * Provides complete tool definitions in Cursor's exact JSON format.
 * This replicates how Cursor presents available tools to AI assistants.
 */
export const ToolSchemasComponent: ContextComponent = {
  id: "tool-schemas",
  name: "Complete Tool Schemas",
  description: "Complete tool definitions with descriptions and parameters",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Get the shared command registry for dynamic tool discovery
    const { sharedCommandRegistry } = require("../../../adapters/shared/command-registry");

    try {
      const allCommands = sharedCommandRegistry.getAllCommands();

      // Convert to tool schemas format matching Cursor's structure
      const toolSchemas: Record<string, any> = {};

      for (const [name, command] of allCommands.entries()) {
        toolSchemas[name] = {
          description: command.description || `${name}: Minsky CLI command`,
          parameters: command.parameters || {
            type: "object",
            properties: {},
            required: [],
          },
        };
      }

      return {
        toolSchemas,
        totalTools: allCommands.size,
      };
    } catch (error) {
      console.warn("Failed to load tool schemas:", error);
      return {
        toolSchemas: {},
        totalTools: 0,
        error: "Failed to load tool schemas",
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

    // Format as JSON exactly like Cursor does
    const toolSchemasJson = JSON.stringify(inputs.toolSchemas, null, 2);

    const content = `Here are the functions available in JSONSchema format:
<functions>
${Object.entries(inputs.toolSchemas)
  .map(
    ([name, schema]) =>
      `<function>${JSON.stringify({ description: schema.description, name, parameters: schema.parameters }, null, 2)}</function>`
  )
  .join("\n")}
</functions>`;

    return {
      content,
      metadata: {
        componentId: "tool-schemas",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["functions"],
        totalTools: inputs.totalTools,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
