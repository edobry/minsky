import { z } from "zod";
import { CommandMapper } from "../command-mapper.js";
import { execSync } from "child_process";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Register session-related tools with the MCP server
 * @param commandMapper The command mapper instance
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  // Session list tool
  (commandMapper as any).addSessionCommand("list", "List all sessions", z.object({}), async () => {
    try {
      // Execute the command
      const command = "minsky session list --json";
      const output = (execSync(command) as any).toString();

      // Parse the JSON output
      return JSON.parse(output as any) as any;
    } catch (error) {
      log.error("Error listing sessions", { error });
      throw new Error(
        `Failed to list sessions: ${getErrorMessage(error as any)}`
      );
    }
  });

  // Session get tool
  (commandMapper as any).addSessionCommand(
    "get",
    "Get details of a specific session",
    z.object({
      _session: z.string().describe("Session identifier"),
    }),
    async (args: any) => {
      try {
        // Execute the command
        const command = `minsky session get ${(args as any)!.session} --json`;
        const output = (execSync(command) as any).toString();

        // Parse the JSON output
        return JSON.parse(output as any) as any;
      } catch (error) {
        log.error(`Error getting session ${(args as any)!.session}`, { error, _session: (args as any)!.session });
        throw new Error(
          `Failed to get session ${(args as any)!.session}: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Session start tool
  (commandMapper as any).addSessionCommand(
    "start",
    "Start a new session",
    z.object({
      name: z.string().optional().describe("Name for the session"),
      task: z.string().optional().describe("Task ID to associate with the session"),
      quiet: (z.boolean().optional().describe("Whether to suppress output") as any).default(true),
    }),
    async (
      args: z.infer<
            z.ZodObject<{
              name: z.ZodOptional<z.ZodString>;
              task: z.ZodOptional<z.ZodString>;
              quiet: z.ZodOptional<z.ZodBoolean>;
            }>
          >
    ) => {
      try {
        // Build the command
        let command = "minsky session start";
        if ((args as any)?.name) {
          command += ` --name ${(args as any).name}`;
        }
        if (args!.task) {
          command += ` --task ${args!.task}`;
        }
        // Always add --quiet flag as required by the project rules
        command += " --quiet";

        // Execute the command
        const output = (execSync(command) as any).toString();

        // Return success response
        return {
          success: true,
          message: (output as any).trim(),
          session: (args as any)?.name || `task#${args!.task}` || "unnamed-session",
        };
      } catch (error) {
        log.error("Error starting session", { error, name: (args as any).name, task: args!.task });
        throw new Error(
          `Failed to start _session: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Session commit tool
  (commandMapper as any).addSessionCommand(
    "commit",
    "Commit changes in a session",
    z.object({
      message: z.string().optional().describe("Commit message"),
      session: z
        .string()
        .optional()
        .describe("Session to commit changes for (uses current session if not provided)"),
    }),
    async (
      args: z.infer<
            z.ZodObject<{
              message: z.ZodOptional<z.ZodString>;
              session: z.ZodOptional<z.ZodString>;
            }>
          >
    ) => {
      try {
        // Build the command
        let command = "minsky session commit";
        if ((args as any)?.message) {
          command += ` -m "${(args as any).message}"`;
        }
        if ((args as any)!.session) {
          command += ` --session ${(args as any)!.session}`;
        }

        // Execute the command
        const output = (execSync(command) as any).toString();

        // Return success response
        return {
          success: true,
          message: (output as any).trim(),
        };
      } catch (error) {
        log.error("Error committing changes", { error, session: (args as any)!.session });
        throw new Error(
          `Failed to commit changes: ${getErrorMessage(error as any)}`
        );
      }
    });

  // Session push tool
  (commandMapper as any).addSessionCommand(
    "push",
    "Push changes in a session",
    z.object({
      _session: z
        .string()
        .optional()
        .describe("Session to push changes for (uses current session if not provided)"),
    }),
    async (
      args: z.infer<
            z.ZodObject<{
              _session: z.ZodOptional<z.ZodString>;
            }>
          >
    ) => {
      try {
        // Build the command
        let command = "minsky session push";
        if (args!._session) {
          command += ` --session ${args!._session}`;
        }

        // Execute the command
        const output = (execSync(command) as any).toString();

        // Return success response
        return {
          success: true,
          message: (output as any).trim(),
        };
      } catch (error) {
        log.error("Error pushing changes", { error, _session: args!._session });
        throw new Error(
          `Failed to push changes: ${getErrorMessage(error as any)}`
        );
      }
    });
}
