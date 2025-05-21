/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import centralized descriptions
import {
  TASK_STATUS_FILTER_DESCRIPTION,
  TASK_ALL_DESCRIPTION,
  TASK_BACKEND_DESCRIPTION,
  TASK_STATUS_DESCRIPTION,
  FORCE_DESCRIPTION
} from "../../utils/option-descriptions.js";

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
      filter: z.string().optional().describe(TASK_STATUS_FILTER_DESCRIPTION),
      all: z.boolean().optional().describe(TASK_ALL_DESCRIPTION),
      backend: z.string().optional().describe(TASK_BACKEND_DESCRIPTION),
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
      taskId: z.union([
        z.string().describe("Task ID to retrieve"),
        z.array(z.string()).describe("Array of task IDs to retrieve")
      ]).describe("Task ID or array of task IDs to retrieve"),
      backend: z.string().optional().describe(TASK_BACKEND_DESCRIPTION),
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
      backend: z.string().optional().describe(TASK_BACKEND_DESCRIPTION),
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
      status: z.string().describe(TASK_STATUS_DESCRIPTION),
      backend: z.string().optional().describe(TASK_BACKEND_DESCRIPTION),
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
      force: z.boolean().optional().describe(FORCE_DESCRIPTION),
      backend: z.string().optional().describe(TASK_BACKEND_DESCRIPTION),
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
