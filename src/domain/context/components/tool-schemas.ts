import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { CommandGeneratorService, getCommandRepresentation } from "../../rules/command-generator";
import { CommandCategory } from "../../../adapters/shared/command-registry";

/**
 * Tool Schemas Component
 *
 * Uses the proper template system to generate clean tool schemas exactly like Cursor's format.
 * Leverages CommandGeneratorService for professional parameter documentation.
 */
export const ToolSchemasComponent: ContextComponent = {
  id: "tool-schemas",
  name: "Complete Tool Schemas",
  description: "Complete tool definitions with descriptions and parameters using template system",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    try {
      // Use the proper command generator service
      const commandGenerator = new CommandGeneratorService({
        interface: context.userPrompt?.includes("xml") ? "mcp" : "cli", // JSON is default like Cursor
        preferMcp: false,
        mcpTransport: "stdio",
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
          const representation = getCommandRepresentation(cmd.id);
          if (representation) {
            toolSchemas[cmd.id] = {
              description: cmd.description,
              parameters:
                representation.parameters.length > 0
                  ? convertParametersToSchema(representation.parameters)
                  : { type: "object", properties: {}, required: [] },
            };
            totalTools++;
          }
        }
      }

      return {
        toolSchemas,
        totalTools,
        format: context.userPrompt?.includes("xml") ? "xml" : "json", // Default to JSON like Cursor
      };
    } catch (error) {
      console.warn("Failed to load tool schemas via template system:", error);
      return {
        toolSchemas: {},
        totalTools: 0,
        error: "Failed to load tool schemas",
        format: "json",
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

    const format = inputs.format || "json";
    let content: string;

    if (format === "json") {
      // Cursor's exact JSON format
      content = `Here are the functions available in JSONSchema format:
${JSON.stringify(inputs.toolSchemas, null, 2)}`;
    } else {
      // XML format (for compatibility)
      content = `Here are the functions available in JSONSchema format:
<functions>
${Object.entries(inputs.toolSchemas)
  .map(
    ([name, schema]) =>
      `<function>${JSON.stringify({ description: schema.description, name, parameters: schema.parameters }, null, 2)}</function>`
  )
  .join("\n")}
</functions>`;
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

/**
 * Convert CommandParameter array to JSON schema format
 */
function convertParametersToSchema(parameters: any[]): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const param of parameters) {
    properties[param.name] = {
      description: param.description || `Parameter: ${param.name}`,
      type: "string", // Simplified like Cursor's format
    };

    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

export function createToolSchemasComponent(): ContextComponent {
  return ToolSchemasComponent;
}
