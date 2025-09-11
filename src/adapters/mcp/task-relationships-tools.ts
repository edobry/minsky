import type { CommandMapper } from "../../mcp/command-mapper";
import { z } from "zod";
import { commandDispatcher } from "../shared/command-dispatcher";
import type { McpExecutionContext } from "../shared/bridges/mcp-bridge";

const AddSchema = z.object({ fromTaskId: z.string(), toTaskId: z.string() });
const RemoveSchema = z.object({ fromTaskId: z.string(), toTaskId: z.string() });
const ListSchema = z.object({
  taskId: z.string(),
  direction: z.enum(["deps", "dependents"]).default("deps"),
});

export function registerTaskRelationshipTools(commandMapper: CommandMapper): void {
  commandMapper.addCommand({
    name: "tasks.relationships.add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: AddSchema,
    handler: async (args) => {
      // Use CommandDispatcher to execute the migrated DatabaseCommand
      const context: McpExecutionContext = {
        interface: "mcp",
        mcpSpecificData: undefined,
      };
      
      const result = await commandDispatcher.executeCommand(
        "tasks.deps.add",
        { task: args.fromTaskId, dependsOn: args.toTaskId },
        context
      );
      
      return { success: result.success, created: result.result?.created || false };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.remove",
    description: "Remove a dependency edge",
    parameters: RemoveSchema,
    handler: async (args) => {
      // Use CommandDispatcher to execute the migrated DatabaseCommand
      const context: McpExecutionContext = {
        interface: "mcp",
        mcpSpecificData: undefined,
      };
      
      const result = await commandDispatcher.executeCommand(
        "tasks.deps.rm",
        { task: args.fromTaskId, dependsOn: args.toTaskId },
        context
      );
      
      return { success: result.success, removed: result.result?.removed || false };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.list",
    description: "List dependencies or dependents for a task",
    parameters: ListSchema,
    handler: async (args) => {
      // Use CommandDispatcher to execute the migrated DatabaseCommand
      const context: McpExecutionContext = {
        interface: "mcp",
        mcpSpecificData: undefined,
      };
      
      const result = await commandDispatcher.executeCommand(
        "tasks.deps.list",
        { task: args.taskId, verbose: true },
        context
      );
      
      if (result.success && result.result) {
        // Return the specific direction requested (dependencies or dependents)
        if (args.direction === "dependents") {
          return { success: true, items: result.result.dependents || [] };
        }
        return { success: true, items: result.result.dependencies || [] };
      }
      
      return { success: false, items: [] };
    },
  });
}
