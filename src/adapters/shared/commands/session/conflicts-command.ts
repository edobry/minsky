/**
 * Session Conflicts Command
 *
 * Command for detecting merge conflicts within session workspaces.
 */
import { z } from "zod";
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import {
  scanSessionConflicts,
  formatSessionConflictResults,
} from "../../../../domain/session/session-conflicts-operations";

/**
 * Parameters for the session conflicts command
 */
export const sessionConflictsCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID",
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

export function createSessionConflictsCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.conflicts",
    category: CommandCategory.SESSION,
    name: "conflicts",
    description: "Detect and report merge conflicts in session workspace",
    parameters: sessionConflictsCommandParams,
    execute: withErrorLogging("session.conflicts", async (params: Record<string, unknown>) => {
      const sessionParams = {
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
      };

      const options = {
        format: (params.format as "json" | "text" | undefined) || "json",
        context: (params.context as number | undefined) || 3,
        files: params.files as string | undefined,
      };

      const deps = await getDeps();
      const result = await scanSessionConflicts(sessionParams, options, deps.sessionProvider);
      const formattedOutput = formatSessionConflictResults(result, options.format);

      return {
        success: true,
        data: formattedOutput,
        conflicts: result.conflicts,
        summary: result.summary,
      };
    }),
  };
}
