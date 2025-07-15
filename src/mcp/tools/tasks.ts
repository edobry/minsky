import { z } from "zod";
import { CommandMapper } from "../command-mapper";
import { execSync } from "child_process";
import { log } from "../../utils/logger";
import { TASK_STATUS_VALUES } from "../../domain/tasks/taskConstants";
import { getErrorMessage } from "../../errors/index";

// Zod schemas for task data validation
const TaskSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(TASK_STATUS_VALUES as [string, ...string[]]).optional(),
  specPath: z.string().optional(),
  worklog: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
});

const TaskListSchema = z.array(TaskSchema);

const TaskStatusSchema = z.object({
  taskId: z.string(),
  status: z.enum(TASK_STATUS_VALUES as [string, ...string[]]),
  updated: z.string().optional(),
});

/**
 * Register task-related tools with the MCP server
 * @param commandMapper The command mapper instance
 */
export function registerTaskTools(commandMapper: CommandMapper): void {
  // Task list tool
  commandMapper.addTaskCommand(
    "list",
    "List all tasks",
    z.object({
      filter: z.string().optional().describe("Filter tasks by status or other criteria"),
      limit: z.number().optional().describe("Limit the number of tasks returned"),
      format: z.enum(["detailed", "simple"] as const).optional().describe("Format of the task list"),
    }),
    async (args: { filter?: string; limit?: number; format?: "detailed" | "simple" }) => {
      try {
        // Build the command with appropriate options
        let command = "minsky tasks list";
        if (args?.filter) {
          command += ` --filter ${args.filter}`;
        }
        if (args?.limit) {
          command += ` --limit ${args.limit}`;
        }
        command += " --json"; // Always return JSON output for MCP

        // Execute the command
        const output = execSync(command).toString();

        // Parse and validate the JSON output
        const parsed = JSON.parse(output);
        const validated = TaskListSchema.parse(parsed);
        return validated as Record<string, unknown>[];
      } catch (error) {
        log.error("MCP: Error listing tasks via execSync", {
          originalError: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack as any : undefined as any,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to list tasks: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Task get tool
  commandMapper.addTaskCommand(
    "get",
    "Get a specific task by ID",
    z.object({
      taskId: z.string().describe("ID of the task to retrieve"),
    }),
    async (args: { taskId: string }) => {
      try {
        // Execute the command
        const command = `minsky tasks get ${args.taskId} --json`;
        const output = execSync(command).toString();

        // Parse and validate the JSON output
        const parsed = JSON.parse(output);
        const validated = TaskSchema.parse(parsed);
        return validated as Record<string, unknown>;
      } catch (error) {
        log.error(`MCP: Error getting task ${args.taskId} via execSync`, {
          originalError: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack as any : undefined as any,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to get task ${(args as any)!.taskId}: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Task status get tool
  commandMapper.addTaskCommand(
    "status.get",
    "Get the status of a task",
    z.object({
      taskId: z.string().describe("ID of the task"),
    }),
    async (args: { taskId: string }) => {
      try {
        // Execute the command
        const command = `minsky tasks status get ${args.taskId}`;
        const output = execSync(command).toString().trim();

        // Format output
        return {
          taskId: args.taskId,
          status: output.split(": ")[1], // Extract the status value
        };
      } catch (error) {
        log.error(`MCP: Error getting task status for ${args.taskId} via execSync`, {
          originalError: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack as any : undefined as any,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to get task status for ${args.taskId}: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Task status set tool
  commandMapper.addTaskCommand(
    "status.set",
    "Set the status of a task",
    z.object({
      taskId: z.string().describe("ID of the task"),
      status: z
        .enum(TASK_STATUS_VALUES as [string, ...string[]])
        .describe("New status for the task"),
    }),
    async (args: { taskId: string; status: string }) => {
      try {
        // Execute the command
        const command = `minsky tasks status set ${args.taskId} ${args.status}`;
        execSync(command);

        // Return success confirmation
        return {
          success: true,
          taskId: args.taskId,
          status: args.status,
        };
      } catch (error) {
        log.error(`MCP: Error setting task status for ${args.taskId} via execSync`, {
          originalError: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack as any : undefined as any,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to set task status for ${args.taskId}: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Task create tool
  commandMapper.addTaskCommand(
    "create",
    "Create a new task from a specification document",
    z.object({
      specPath: z.string().describe("Path to the task specification document"),
    }),
    async (args: { specPath: string }) => {
      try {
        // Execute the command
        const command = `minsky tasks create ${args.specPath} --json`;
        const output = execSync(command).toString();

        // Parse and validate the JSON output
        const parsed = JSON.parse(output);
        const validated = TaskSchema.parse(parsed);
        return validated as Record<string, unknown>;
      } catch (error) {
        log.error("MCP: Error creating task via execSync", {
          originalError: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack as any : undefined as any,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to create task: ${getErrorMessage(error as any)}`
        );
      }
    });
}
