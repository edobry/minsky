/**
 * Session Conflicts Command
 *
 * Command for detecting merge conflicts within session workspaces.
 */
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import {
  scanSessionConflicts,
  formatSessionConflictResults,
} from "../../../../domain/session/session-conflicts-operations";

/**
 * Parameters for the session conflicts command
 */
export const sessionConflictsCommandParams = {
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID to identify session",
    required: false,
  },
  format: {
    schema: z.enum(["json", "text"]),
    description: "Output format for conflict results",
    required: false,
    defaultValue: "json",
  },
  context: {
    schema: z.number(),
    description: "Number of context lines to include around conflicts",
    required: false,
    defaultValue: 3,
  },
  files: {
    schema: z.string(),
    description: "File pattern to limit conflict scanning (e.g. '*.ts')",
    required: false,
  },
};

/**
 * Session Conflicts Command
 */
export class SessionConflictsCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.conflicts";
  }

  getCommandName(): string {
    return "conflicts";
  }

  getCommandDescription(): string {
    return "Detect and report merge conflicts in session workspace";
  }

  getParameterSchema(): Record<string, any> {
    return sessionConflictsCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const sessionParams = {
      name: params.name,
      task: params.task,
    };

    const options = {
      format: params.format || "json",
      context: params.context || 3,
      files: params.files,
    };

    const result = await scanSessionConflicts(sessionParams, options);
    const formattedOutput = formatSessionConflictResults(result, options.format);

    return this.createSuccessResult({
      data: formattedOutput,
      conflicts: result.conflicts,
      summary: result.summary,
    });
  }
}

/**
 * Factory function for creating the session conflicts command
 */
export function createSessionConflictsCommand(
  deps?: SessionCommandDependencies
): SessionConflictsCommand {
  return new SessionConflictsCommand(deps);
}
