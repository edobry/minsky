import {
  type ContextComponent,
  type ComponentInput,
  type ComponentOutput,
  type ComponentInputs,
} from "./types";
// Import command discovery infrastructure
import { sharedCommandRegistry } from "../../../adapters/shared/command-registry";
import { CommandCategory } from "../../../adapters/shared/command-registry";

interface ToolSchema {
  name: string;
  category: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
    defaultValue?: any;
  }>;
}

interface ToolSchemasInputs {
  availableTools: ToolSchema[];
  toolsByCategory: Record<string, ToolSchema[]>;
  totalTools: number;
  userPrompt?: string;
  filteredTools?: ToolSchema[];
}

export const ToolSchemasComponent: ContextComponent = {
  id: "tool-schemas",
  name: "Tool Schemas",
  description: "Available CLI tools and their parameter schemas for AI assistance",

  // Phase 1: Async input gathering (hybrid: dynamic discovery + filtering)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const userPrompt = context.userQuery;
    const availableTools: ToolSchema[] = [];
    const toolsByCategory: Record<string, ToolSchema[]> = {};

    try {
      // Discover all available commands from the shared registry
      const allCommands = sharedCommandRegistry.getAllCommands();

      // Convert commands to tool schemas
      for (const command of allCommands) {
        const toolSchema: ToolSchema = {
          name: command.id,
          category: command.category.toString(),
          description: command.description || "No description available",
          parameters: [],
        };

        // Extract parameter schemas
        if (command.parameters) {
          for (const [paramName, paramDef] of Object.entries(command.parameters)) {
            toolSchema.parameters.push({
              name: paramName,
              type: paramDef.type || "string",
              required: paramDef.required || false,
              description: paramDef.description,
              defaultValue: paramDef.defaultValue,
            });
          }
        }

        availableTools.push(toolSchema);

        // Group by category
        const categoryName = toolSchema.category;
        if (!toolsByCategory[categoryName]) {
          toolsByCategory[categoryName] = [];
        }
        toolsByCategory[categoryName].push(toolSchema);
      }

      // Filter tools based on user prompt if provided
      let filteredTools: ToolSchema[] | undefined;
      if (userPrompt) {
        const promptLower = userPrompt.toLowerCase();
        filteredTools = availableTools.filter((tool) => {
          return (
            tool.name.toLowerCase().includes(promptLower) ||
            tool.description.toLowerCase().includes(promptLower) ||
            tool.category.toLowerCase().includes(promptLower) ||
            // Check if any parameter matches
            tool.parameters.some(
              (param) =>
                param.name.toLowerCase().includes(promptLower) ||
                param.description?.toLowerCase().includes(promptLower)
            )
          );
        });
      }

      return {
        availableTools,
        toolsByCategory,
        totalTools: availableTools.length,
        userPrompt,
        filteredTools,
      } as ToolSchemasInputs;
    } catch (error) {
      // Fallback with empty tools on error
      return {
        availableTools: [],
        toolsByCategory: {},
        totalTools: 0,
        userPrompt,
        error: `Failed to discover tools: ${error instanceof Error ? error.message : String(error)}`,
      } as ToolSchemasInputs;
    }
  },

  // Phase 2: Pure rendering with template-style formatting
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const toolInputs = inputs as ToolSchemasInputs;

    let content = `## Tool Schemas\n\n`;

    // Overview
    content += `### Available Tools Overview\n`;
    content += `- Total Tools: ${toolInputs.totalTools}\n`;
    content += `- Categories: ${Object.keys(toolInputs.toolsByCategory).length}\n`;

    if (toolInputs.userPrompt && toolInputs.filteredTools) {
      content += `- Filtered by "${toolInputs.userPrompt}": ${toolInputs.filteredTools.length} tools\n`;
    }

    content += `\n`;

    // Category breakdown
    if (Object.keys(toolInputs.toolsByCategory).length > 0) {
      content += `### Tools by Category\n`;
      for (const [category, tools] of Object.entries(toolInputs.toolsByCategory)) {
        content += `- **${category}**: ${tools.length} tools\n`;
      }
      content += `\n`;
    }

    // Detailed tool schemas (show filtered if available, otherwise show by category)
    const toolsToShow = toolInputs.filteredTools || toolInputs.availableTools;

    if (toolsToShow.length > 0) {
      if (toolInputs.filteredTools) {
        content += `### Filtered Tools (${toolInputs.filteredTools.length})\n\n`;
      } else {
        content += `### Available Tool Schemas\n\n`;
      }

      // Group tools for display
      const displayTools = toolInputs.filteredTools
        ? toolInputs.filteredTools
        : // Show first 10 tools from each category for brevity
          Object.values(toolInputs.toolsByCategory).flat().slice(0, 15);

      for (const tool of displayTools) {
        content += `#### ${tool.name} (${tool.category})\n`;
        content += `${tool.description}\n\n`;

        if (tool.parameters.length > 0) {
          content += `**Parameters:**\n`;
          for (const param of tool.parameters) {
            const requiredMarker = param.required ? "*" : "";
            const defaultInfo = param.defaultValue ? ` (default: ${param.defaultValue})` : "";
            content += `- \`${param.name}\`${requiredMarker} (${param.type})${defaultInfo}`;
            if (param.description) {
              content += ` - ${param.description}`;
            }
            content += `\n`;
          }
        } else {
          content += `**Parameters:** None\n`;
        }
        content += `\n`;
      }

      // Show summary if we truncated
      if (!toolInputs.filteredTools && toolInputs.totalTools > 15) {
        content += `*Showing first 15 tools. Use --prompt with specific keywords to filter tools.*\n\n`;
      }
    }

    // Usage guidelines for AI
    content += `### Tool Usage Guidelines\n`;
    content += `- **Parameter Validation**: All required parameters marked with * must be provided\n`;
    content += `- **Type Safety**: Respect parameter types (string, number, boolean, etc.)\n`;
    content += `- **Default Values**: Parameters with defaults can be omitted\n`;
    content += `- **Categories**: Tools are organized by functional areas (TASKS, SESSION, GIT, etc.)\n`;
    content += `- **Error Handling**: Tools provide structured error responses for debugging\n\n`;

    // Context-specific recommendations
    if (toolInputs.userPrompt) {
      content += `### Context-Specific Recommendations\n`;
      const promptLower = toolInputs.userPrompt.toLowerCase();

      if (promptLower.includes("task") || promptLower.includes("todo")) {
        content += `- Focus on **TASKS** category tools for task management\n`;
      }
      if (promptLower.includes("session") || promptLower.includes("workspace")) {
        content += `- Use **SESSION** category tools for workspace isolation\n`;
      }
      if (
        promptLower.includes("git") ||
        promptLower.includes("commit") ||
        promptLower.includes("branch")
      ) {
        content += `- Leverage **GIT** category tools for version control operations\n`;
      }
      if (promptLower.includes("rule") || promptLower.includes("config")) {
        content += `- Utilize **RULES** category tools for project configuration\n`;
      }
      if (promptLower.includes("debug") || promptLower.includes("test")) {
        content += `- Consider **DEBUG** category tools for troubleshooting\n`;
      }

      content += `\n`;
    }

    return {
      content,
      metadata: {
        componentId: this.id,
        generatedAt: new Date().toISOString(),
        tokenCount: Math.floor(content.length / 4), // rough token estimate
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
