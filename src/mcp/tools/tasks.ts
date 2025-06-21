import { z } from "zod";
import { CommandMapper } from "../command-mapper.js";
import { execSync } from "child_process";
import { log } from "../../utils/logger";
import { TASK_STATUS_VALUES } from "../../domain/tasks/taskConstants.js";

/**
 * Register task-related tools with the MCP server
 * @param commandMapper The command mapper instance
 */
export function registerTaskTools(_commandMapper: CommandMapper): void {
  // Task list tool
  commandMapper.addTaskCommand(
    "list",
    "List all tasks",
    z.object({
      filter: z.string().optional().describe("Filter tasks by status or other criteria"),
      limit: z.number().optional().describe("Limit the number of tasks returned"),
      format: z.enum(["detailed", "simple"]).optional().describe("Format of the task list"),
    }),
    async (
      _args: z.infer<
        z.ZodObject<{
          filter: z.ZodOptional<z.ZodString>;
          limit: z.ZodOptional<z.ZodNumber>;
          format: z.ZodOptional<z.ZodEnum<["detailed", "simple"]>>;
        }>
      >
    ) => {
      try {
        // Build the command with appropriate options
        let _command = "minsky tasks list";
        if (_args.filter) {
          command += ` --filter ${args.filter}`;
        }
        if (_args.limit) {
          command += ` --limit ${args.limit}`;
        }
        command += " --json"; // Always return JSON output for MCP

        // Execute the command
        const output = execSync(_command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch {
        log.error("MCP: Error listing tasks via execSync", {
          originalError: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task get tool
  commandMapper.addTaskCommand(
    "get",
    "Get a specific task by ID",
    z.object({
      _taskId: z.string().describe("ID of the task to retrieve"),
    }),
    async (_args: unknown) => {
      try {
        // Execute the command
        const command = `minsky tasks get ${args.taskId} --json`;
        const output = execSync(_command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch {
        log.error(`MCP: Error getting task ${_args._taskId} via execSync`, {
          originalError: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to get task ${_args._taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task status get tool
  commandMapper.addTaskCommand(
    "status.get",
    "Get the status of a task",
    z.object({
      _taskId: z.string().describe("ID of the task"),
    }),
    async (_args: unknown) => {
      try {
        // Execute the command
        const command = `minsky tasks status get ${args.taskId}`;
        const output = execSync(_command).toString().trim();

        // Format output
        return {
          taskId: args.taskId,
          status: output.split(": ")[1], // Extract the status value
        };
      } catch {
        log.error(`MCP: Error getting task status for ${_args._taskId} via execSync`, {
          originalError: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to get task status for ${_args._taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task status set tool
  commandMapper.addTaskCommand(
    "status.set",
    "Set the status of a task",
    z.object({
      _taskId: z.string().describe("ID of the task"),
      status: z
        .enum(TASK_STATUS_VALUES as [string, ...string[]])
        .describe("New status for the task"),
    }),
    async (
      _args: z.infer<
        z.ZodObject<{
          _taskId: z.ZodString;
          status: z.ZodEnum<typeof TASK_STATUS_VALUES>;
        }>
      >
    ) => {
      try {
        // Execute the command
        const command = `minsky tasks status set ${args.taskId} ${args.status}`;
        execSync(_command);

        // Return success confirmation
        return {
          success: true,
          taskId: args.taskId,
          status: args.status,
        };
      } catch {
        log.error(`MCP: Error setting task status for ${_args._taskId} via execSync`, {
          originalError: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to set task status for ${_args._taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task create tool
  commandMapper.addTaskCommand(
    "create",
    "Create a new task from a specification document",
    z.object({
      specPath: z.string().describe("Path to the task specification document"),
    }),
    async (_args: unknown) => {
      try {
        // Execute the command
        const command = `minsky tasks create ${args.specPath} --json`;
        const output = execSync(_command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch {
        log.error("MCP: Error creating task via execSync", {
          originalError: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mcpArgs: args,
        });
        throw new Error(
          `Failed to create task: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
