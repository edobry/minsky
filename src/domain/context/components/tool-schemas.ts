import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Tool Schemas Component
 *
 * Provides complete tool definitions in configurable format (XML or JSON).
 * Cleans up verbose Zod schemas to match Cursor's simple parameter format.
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

      // Convert to clean tool schemas format matching Cursor's structure
      const toolSchemas: Record<string, any> = {};

      for (const [name, command] of allCommands.entries()) {
        toolSchemas[name] = {
          description: command.description || `${name}: Minsky CLI command`,
          parameters: cleanParameterSchema(
            command.parameters || {
              type: "object",
              properties: {},
              required: [],
            }
          ),
        };
      }

      return {
        toolSchemas,
        totalTools: allCommands.size,
        format: context.userPrompt?.includes("json") ? "json" : "xml", // Allow format selection via prompt
      };
    } catch (error) {
      console.warn("Failed to load tool schemas:", error);
      return {
        toolSchemas: {},
        totalTools: 0,
        error: "Failed to load tool schemas",
        format: "xml",
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

    const format = inputs.format || "xml";
    let content: string;

    if (format === "json") {
      // Cursor's JSON format
      content = `## Complete Tool Schemas

Here are the complete tool definitions:

\`\`\`json
${JSON.stringify(inputs.toolSchemas, null, 2)}
\`\`\``;
    } else {
      // XML format (default, more structured)
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
        format: format,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};

/**
 * Clean up verbose Zod schemas to match Cursor's simple parameter format
 */
function cleanParameterSchema(rawSchema: any): any {
  if (!rawSchema || typeof rawSchema !== "object") {
    return { type: "object", properties: {}, required: [] };
  }

  // If it's already clean, return as-is
  if (rawSchema.type && rawSchema.properties && !hasZodVerbosity(rawSchema)) {
    return rawSchema;
  }

  // Clean up Zod-generated schemas
  return {
    type: "object",
    properties: cleanProperties(rawSchema.properties || {}),
    required: Array.isArray(rawSchema.required) ? rawSchema.required : [],
  };
}

/**
 * Check if schema has Zod verbosity that needs cleaning
 */
function hasZodVerbosity(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;

  // Look for Zod-specific patterns
  const hasZodMarkers =
    JSON.stringify(obj).includes('"_def"') ||
    JSON.stringify(obj).includes('"~standard"') ||
    JSON.stringify(obj).includes('"typeName"');

  return hasZodMarkers;
}

/**
 * Clean up property definitions to remove Zod verbosity
 */
function cleanProperties(properties: any): any {
  if (!properties || typeof properties !== "object") {
    return {};
  }

  const cleaned: any = {};

  for (const [key, prop] of Object.entries(properties)) {
    cleaned[key] = cleanProperty(prop as any);
  }

  return cleaned;
}

/**
 * Clean up individual property definition
 */
function cleanProperty(prop: any): any {
  if (!prop || typeof prop !== "object") {
    return { type: "string" };
  }

  // If it has Zod schema structure, extract the clean parts
  if (prop.schema && hasZodVerbosity(prop.schema)) {
    return {
      type: inferTypeFromZodSchema(prop.schema),
      description: prop.description || undefined,
      required: prop.required || false,
    };
  }

  // If it's already clean, return as-is but ensure it has type
  return {
    type: prop.type || "string",
    description: prop.description || undefined,
    required: prop.required || false,
  };
}

/**
 * Infer simple type from Zod schema definition
 */
function inferTypeFromZodSchema(zodSchema: any): string {
  if (!zodSchema || !zodSchema._def) {
    return "string";
  }

  const typeName = zodSchema._def.typeName;

  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
      return "array";
    case "ZodObject":
      return "object";
    default:
      return "string";
  }
}
