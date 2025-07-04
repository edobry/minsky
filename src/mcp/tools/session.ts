import { z } from "zod";
import { CommandMapper } from "../command-mapper.js";
import { execSync } from "child_process";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../errors/index";

/**
 * Register session-related tools with the MCP server
 * @param commandMapper The command mapper instance
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  // Session list tool
  commandMapper.addSessionCommand("list", "List all sessions", z.object({}), async () => {
    try {
      // Execute the command
      const _command = "minsky session list --json";
      const output = execSync(_command).toString();

      // Parse the JSON output
      return JSON.parse(output);
    } catch (error) {
      log.error("Error listing sessions", { error });
      throw new Error(
        `Failed to list sessions: ${getErrorMessage(error)}`
      );
    }
  });

  // Session get tool
  commandMapper.addSessionCommand(
    "get",
    "Get details of a specific session",
    z.object({
      _session: z.string().describe("Session identifier"),
    }),
    async (args: unknown) => {
      try {
        // Execute the command
        const _command = `minsky session get ${args.session} --json`;
        const output = execSync(_command).toString();

        // Parse the JSON output
        return JSON.parse(output);
      } catch (error) {
        log.error(`Error getting session ${args.session}`, { error, _session: args.session });
        throw new Error(
          `Failed to get session ${args.session}: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Session start tool
  commandMapper.addSessionCommand(
    "start",
    "Start a new session",
    z.object({
      name: z.string().optional().describe("Name for the session"),
      task: z.string().optional().describe("Task ID to associate with the session"),
      quiet: z.boolean().optional().describe("Whether to suppress output").default(true),
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
        if (args.name) {
          command += ` --name ${args.name}`;
        }
        if (args.task) {
          command += ` --task ${args.task}`;
        }
        // Always add --quiet flag as required by the project rules
        command += " --quiet";

        // Execute the command
        const output = execSync(_command).toString();

        // Return success response
        return {
          success: true,
          message: output.trim(),
          session: args.name || `task#${args.task}` || "unnamed-session",
        };
      } catch (error) {
        log.error("Error starting session", { error, name: args.name, task: args.task });
        throw new Error(
          `Failed to start _session: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Session commit tool
  commandMapper.addSessionCommand(
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
          _session: z.ZodOptional<z.ZodString>;
        }>
      >
    ) => {
      try {
        // Build the command
        let command = "minsky session commit";
        if (args.message) {
          command += ` -m "${args.message}"`;
        }
        if (args.session) {
          command += ` --session ${args.session}`;
        }

        // Execute the command
        const output = execSync(_command).toString();

        // Return success response
        return {
          success: true,
          message: output.trim(),
        };
      } catch (error) {
        log.error("Error committing changes", { error, _session: args.session });
        throw new Error(
          `Failed to commit changes: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Session push tool
  commandMapper.addSessionCommand(
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
        if (args.session) {
          command += ` --session ${args.session}`;
        }

        // Execute the command
        const output = execSync(_command).toString();

        // Return success response
        return {
          success: true,
          message: output.trim(),
        };
      } catch (error) {
        log.error("Error pushing changes", { error, _session: args.session });
        throw new Error(
          `Failed to push changes: ${getErrorMessage(error)}`
        );
      }
    }
  );
}
