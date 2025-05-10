/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { listTasksFromParams, getTaskFromParams } from "../../domain/index.js";

/**
 * Registers task tools with the MCP command mapper
 */
export function registerTaskTools(commandMapper: CommandMapper): void {
  // Task list command
  commandMapper.addTaskCommand(
    "list",
    "List all tasks",
    z.object({
      filter: z.string().optional().describe("Filter tasks by status"),
      all: z.boolean().optional().describe("Include completed tasks"),
      backend: z.string().optional().describe("Task backend (markdown, github)")
    }),
    async (args) => {
      const params = {
        filter: args.filter,
        all: args.all ?? false,
        backend: args.backend,
        json: true // Always use JSON format for MCP
      };
      
      return await listTasksFromParams(params);
    }
  );
  
  // Task get command
  commandMapper.addTaskCommand(
    "get",
    "Get a task by ID",
    z.object({
      taskId: z.string().describe("Task ID to retrieve"),
      backend: z.string().optional().describe("Task backend (markdown, github)")
    }),
    async (args) => {
      const params = {
        taskId: args.taskId,
        backend: args.backend,
        json: true // Always use JSON format for MCP
      };
      
      return await getTaskFromParams(params);
    }
  );
  
  // Add other task commands as needed
} 
