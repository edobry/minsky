import { z } from "zod";
import { CommandMapper } from "../command-mapper.js";
import { execSync } from "child_process";

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
      format: z.enum(["detailed", "simple"]).optional().describe("Format of the task list"),
    }),
    async (
      args: z.infer<
        z.ZodObject<{
          filter: z.ZodOptional<z.ZodString>;
          limit: z.ZodOptional<z.ZodNumber>;
          format: z.ZodOptional<z.ZodEnum<["detailed", "simple"]>>;
        }>
      >
    ) => {
      try {
        // Build the command with appropriate options
        let command = "minsky tasks list";
        if (args.filter) {
          command += ` --filter ${args.filter}`;
        }
        if (args.limit) {
          command += ` --limit ${args.limit}`;
        }
        command += " --json"; // Always return JSON output for MCP

        // Execute the command
        const output = execSync(command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch (error) {
        console.error("Error listing tasks:", error);
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
      taskId: z.string().describe("ID of the task to retrieve"),
    }),
    async (args: z.infer<z.ZodObject<{ taskId: z.ZodString }>>) => {
      try {
        // Execute the command
        const command = `minsky tasks get ${args.taskId} --json`;
        const output = execSync(command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch (error) {
        console.error(`Error getting task ${args.taskId}:`, error);
        throw new Error(
          `Failed to get task ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task status get tool
  commandMapper.addTaskCommand(
    "status.get",
    "Get the status of a task",
    z.object({
      taskId: z.string().describe("ID of the task"),
    }),
    async (args: z.infer<z.ZodObject<{ taskId: z.ZodString }>>) => {
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
        console.error(`Error getting task status for ${args.taskId}:`, error);
        throw new Error(
          `Failed to get task status for ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Task status set tool
  commandMapper.addTaskCommand(
    "status.set",
    "Set the status of a task",
    z.object({
      taskId: z.string().describe("ID of the task"),
      status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE"]).describe("New status for the task"),
    }),
    async (
      args: z.infer<
        z.ZodObject<{
          taskId: z.ZodString;
          status: z.ZodEnum<["TODO", "IN_PROGRESS", "REVIEW", "DONE"]>;
        }>
      >
    ) => {
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
        console.error(`Error setting task status for ${args.taskId}:`, error);
        throw new Error(
          `Failed to set task status for ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`
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
    async (args: z.infer<z.ZodObject<{ specPath: z.ZodString }>>) => {
      try {
        // Execute the command
        const command = `minsky tasks create ${args.specPath} --json`;
        const output = execSync(command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch (error) {
        console.error("Error creating task:", error);
        throw new Error(
          `Failed to create task: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
