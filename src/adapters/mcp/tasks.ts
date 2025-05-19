/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import domain functions
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
} from "../../domain/index.js";

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
      backend: z.string().optional().describe("Task backend (markdown, github)"),
    }),
    async (args) => {
      const params = {
        ...args,
        all: args.all ?? false, // Provide default for 'all'
        json: true, // Always use JSON format for MCP
      };

      return JSON.stringify(await listTasksFromParams(params));
    }
  );

  // Task get command
  commandMapper.addTaskCommand(
    "get",
    "Get a task by ID",
    z.object({
      taskId: z.string().describe("Task ID to retrieve"),
      backend: z.string().optional().describe("Task backend (markdown, github)"),
    }),
    async (args) => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      return JSON.stringify(await getTaskFromParams(params));
    }
  );

  // Task status get command
  commandMapper.addTaskCommand(
    "status.get",
    "Get the status of a task",
    z.object({
      taskId: z.string().describe("Task ID to retrieve status for"),
      backend: z.string().optional().describe("Task backend (markdown, github)"),
    }),
    async (args) => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const status = await getTaskStatusFromParams(params);

      // Format the response for MCP
      return {
        taskId: args.taskId,
        status,
      };
    }
  );

  // Task status set command
  commandMapper.addTaskCommand(
    "status.set",
    "Set the status of a task",
    z.object({
      taskId: z.string().describe("Task ID to set status for"),
      status: z.string().describe("Status to set (TODO, IN-PROGRESS, IN-REVIEW, DONE)"),
      backend: z.string().optional().describe("Task backend (markdown, github)"),
    }),
    async (args) => {
      const params = {
        ...args,
        status: args.status as "TODO" | "IN-PROGRESS" | "IN-REVIEW" | "DONE", // Cast to expected type
      };

      await setTaskStatusFromParams(params);

      // For MCP, return a success response
      return {
        success: true,
        taskId: args.taskId,
        status: args.status,
      };
    }
  );

  // Task create command
  commandMapper.addTaskCommand(
    "create",
    "Create a new task from a specification file",
    z.object({
      specPath: z.string().describe("Path to the task specification file"),
      force: z.boolean().optional().describe("Force creation even if task already exists"),
      backend: z.string().optional().describe("Task backend (markdown, github)"),
    }),
    async (args) => {
      const params = {
        ...args,
        force: args.force ?? false, // Provide default for 'force'
        json: true, // Always use JSON format for MCP
      };

      const task = await createTaskFromParams(params);

      return {
        success: true,
        task,
      };
    }
  );
}
