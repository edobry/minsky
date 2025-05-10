/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import from domain index
import { 
  listTasksFromParams, 
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams
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
      backend: z.string().optional().describe("Task backend (markdown, github)")
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args): Promise<any> => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args): Promise<any> => {
      const params = {
        taskId: args.taskId,
        backend: args.backend,
        json: true // Always use JSON format for MCP
      };
      
      return await getTaskFromParams(params);
    }
  );
  
  // Task status get command
  commandMapper.addTaskCommand(
    "statusGet",
    "Get the status of a task",
    z.object({
      taskId: z.string().describe("Task ID to retrieve status for"),
      backend: z.string().optional().describe("Task backend (markdown, github)")
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args): Promise<any> => {
      const params = {
        taskId: args.taskId,
        backend: args.backend,
        json: true // Always use JSON format for MCP
      };
      
      const status = await getTaskStatusFromParams(params);
      
      // Format the response for MCP
      return {
        taskId: args.taskId,
        status
      };
    }
  );
  
  // Task status set command
  commandMapper.addTaskCommand(
    "statusSet",
    "Set the status of a task",
    z.object({
      taskId: z.string().describe("Task ID to set status for"),
      status: z.string().describe("Status to set (TODO, IN-PROGRESS, IN-REVIEW, DONE)"),
      backend: z.string().optional().describe("Task backend (markdown, github)")
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args): Promise<any> => {
      const params = {
        taskId: args.taskId,
        status: args.status,
        backend: args.backend
      };
      
      await setTaskStatusFromParams(params);
      
      // For MCP, return a success response
      return {
        success: true,
        taskId: args.taskId,
        status: args.status
      };
    }
  );
} 
