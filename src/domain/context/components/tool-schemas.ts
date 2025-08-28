import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { CommandGeneratorService } from "../../rules/command-generator";
import { CommandCategory, sharedCommandRegistry } from "../../../adapters/shared/command-registry";
import { z } from "zod";
import { log } from "../../../utils/logger";

/**
 * Attempt to load the ToolSimilarityService lazily.
 * Returns null when unavailable (e.g., test environments).
 */
async function maybeCreateToolSimilarityService(): Promise<null | any> {
  try {
    // Dynamic import guarded in try/catch to avoid hard failure
    const mod: any = await import("../../tools/similarity/tool-similarity-service");
    if (mod && typeof mod.createToolSimilarityService === "function") {
      return await mod.createToolSimilarityService();
    }
    return null;
  } catch {
    return null;
  }
}

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
      items: zodToJsonSchema((zodSchema as any)._def.type),
    };
  } else if (zodSchema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: (zodSchema as any)._def.values,
    };
  } else if (zodSchema instanceof z.ZodUnion) {
    const types = (zodSchema as any)._def.options.map((option: z.ZodTypeAny) =>
      zodToJsonSchema(option)
    );
    return types[0] || { type: "string" };
  } else if (zodSchema instanceof z.ZodOptional) {
    return zodToJsonSchema((zodSchema as any)._def.innerType);
  } else if (zodSchema instanceof z.ZodDefault) {
    return zodToJsonSchema((zodSchema as any)._def.innerType);
  } else {
    return { type: "string" };
  }
}

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
    const jsonSchema = zodToJsonSchema((paramDef as any).schema);
    if ((paramDef as any).description) {
      (jsonSchema as any).description = (paramDef as any).description;
    }
    if ((paramDef as any).defaultValue !== undefined) {
      (jsonSchema as any).default = (paramDef as any).defaultValue;
    }
    properties[paramName] = jsonSchema;
    if ((paramDef as any).required) {
      required.push(paramName);
    }
  }
  return { properties, required };
}

export const ToolSchemasComponent: ContextComponent = {
  id: "tool-schemas",
  name: "Complete Tool Schemas",
  description: "Complete tool definitions with descriptions and parameters using template system",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    try {
      const interfaceConfig = context.interfaceConfig || {
        interface: "cli" as const,
        mcpEnabled: false,
        preferMcp: false,
      };

      const registry = context.commandRegistry || sharedCommandRegistry;

      const userQuery = context.userQuery || context.userPrompt;
      let shouldFilterByQuery = Boolean(userQuery?.trim()) && !context.commandRegistry;

      let toolSchemas: Record<string, any> = {};
      let totalTools = 0;
      let filteredBy: string | undefined;
      let originalToolCount: number | undefined;
      let reductionPercentage: number | undefined;

      if (shouldFilterByQuery) {
        const toolSimilarityService = await maybeCreateToolSimilarityService();
        if (!toolSimilarityService) {
          // Fallback if similarity service isn't available in this environment
          shouldFilterByQuery = false;
        } else {
          try {
            const relevantTools = await toolSimilarityService.findRelevantTools({
              query: userQuery!,
              limit: 20,
              threshold: 0.1,
            });

            for (const relevantTool of relevantTools) {
              const { properties, required } = extractParameterSchemas(relevantTool.tool.id);
              if (interfaceConfig.interface === "cli") {
                toolSchemas[relevantTool.tool.id] = {
                  description: relevantTool.tool.description,
                  parameters: { type: "object", properties, required },
                  _relevance: {
                    score: relevantTool.relevanceScore,
                    reason: relevantTool.reason,
                  },
                };
              } else {
                toolSchemas[relevantTool.tool.id] = {
                  description: relevantTool.tool.description,
                  syntax: (relevantTool.tool as any).syntax,
                  parameters: { type: "object", properties, required },
                  _relevance: {
                    score: relevantTool.relevanceScore,
                    reason: relevantTool.reason,
                  },
                };
              }
              totalTools++;
            }

            const allCommands = registry.getAllCommands();
            originalToolCount = allCommands.length;
            reductionPercentage =
              originalToolCount > 0
                ? Math.round(((originalToolCount - totalTools) / originalToolCount) * 100)
                : 0;
            filteredBy = "user-query";
          } catch (error) {
            log.warn(
              "Failed to apply query-aware tool filtering, falling back to all tools:",
              error
            );
            shouldFilterByQuery = false;
          }
        }
      }

      if (!shouldFilterByQuery) {
        const categories = [
          CommandCategory.TASKS,
          CommandCategory.SESSION,
          CommandCategory.SESSIONDB,
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
            const { properties, required } = extractParameterSchemas((cmd as any).id);
            if (interfaceConfig.interface === "cli") {
              toolSchemas[(cmd as any).id] = {
                description: (cmd as any).description,
                parameters: { type: "object", properties, required },
              };
            } else {
              toolSchemas[(cmd as any).id] = {
                description: (cmd as any).description,
                syntax: (cmd as any).syntax,
                parameters: { type: "object", properties, required },
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
        filteredBy,
        originalToolCount,
        reductionPercentage,
        queryUsed: userQuery,
      };
    } catch (error) {
      log.warn("Failed to load tool schemas via template system:", error);
      return {
        toolSchemas: {},
        totalTools: 0,
        error: "Failed to load tool schemas",
        interfaceMode: "cli",
        shouldUseMcp: false,
      };
    }
  },

  render(inputs: ComponentInputs): ComponentOutput {
    if ((inputs as any).error) {
      const content = `## Complete Tool Schemas\n\nError loading tool schemas: ${(inputs as any).error}\n\nAvailable tools could not be determined.`;
      return {
        content,
        metadata: {
          componentId: "tool-schemas",
          tokenCount: content.length / 4,
          sections: ["tool_schemas"],
        },
      };
    }

    const cleanToolSchemas: Record<string, any> = {};
    for (const [toolId, schema] of Object.entries((inputs as any).toolSchemas)) {
      const { _relevance, ...cleanSchema } = schema as any;
      cleanToolSchemas[toolId] = cleanSchema;
    }

    let content: string;
    if ((inputs as any).shouldUseMcp) {
      content = `Here are the functions available in JSONSchema format:\n<functions>\n${Object.entries(
        cleanToolSchemas
      )
        .map(
          ([name, schema]) =>
            `<function>${JSON.stringify({ description: (schema as any).description, name, parameters: (schema as any).parameters }, null, 2)}</function>`
        )
        .join("\n")}\n</functions>`;
    } else {
      content = `Here are the functions available in JSONSchema format:\n${JSON.stringify(cleanToolSchemas, null, 2)}`;
    }

    if ((inputs as any).filteredBy === "user-query" && (inputs as any).queryUsed) {
      const filteringSummary = `\n\n<!-- Context-Aware Tool Filtering Applied -->\n<!-- Query: "${(inputs as any).queryUsed}" -->\n<!-- Tools: ${(inputs as any).totalTools} selected from ${(inputs as any).originalToolCount} total (${(inputs as any).reductionPercentage}% reduction) -->\n<!-- This reduces context pollution while providing relevant tools for your query -->`;
      content += filteringSummary;
    }

    return {
      content,
      metadata: {
        componentId: "tool-schemas",
        tokenCount: content.length / 4,
        sections: ["functions"],
        totalTools: (inputs as any).totalTools,
        filteredBy: (inputs as any).filteredBy,
        originalToolCount: (inputs as any).originalToolCount,
        reductionPercentage: (inputs as any).reductionPercentage,
        queryUsed: (inputs as any).queryUsed,
      },
    };
  },

  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs);
  },
};

export function createToolSchemasComponent(): ContextComponent {
  return ToolSchemasComponent;
}
