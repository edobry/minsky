/**
 * Session Generate Prompt Command
 *
 * Generates complete subagent prompt strings for session work.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { z } from "zod";

const promptCommandParams = {
  task: { schema: z.string(), description: "Task ID (required)", required: true },
  type: {
    schema: z.enum(["implementation", "refactor", "review", "cleanup"]),
    description: "Prompt type: implementation, refactor, review, or cleanup",
    required: true,
  },
  instructions: {
    schema: z.string(),
    description: "Specific work instructions for the subagent",
    required: true,
  },
  scope: {
    schema: z.string(),
    description: "Comma-separated list of file paths to constrain to",
    required: false,
  },
};

export function createSessionGeneratePromptCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.generate_prompt",
    category: CommandCategory.SESSION,
    name: "generate_prompt",
    description: "Generate a complete subagent prompt for session work",
    parameters: promptCommandParams,
    execute: withErrorLogging("session.generate_prompt", async (params) => {
      const { getSessionFromParams } = await import("../../../../domain/session");
      const { generateSubagentPrompt } = await import(
        "../../../../domain/session/prompt-generation"
      );
      const { resolveSessionDirectory } = await import(
        "../../../../domain/session/resolve-session-directory"
      );

      const task = params.task as string;
      const type = params.type as "implementation" | "refactor" | "review" | "cleanup";
      const instructions = params.instructions as string;
      const scopeRaw = params.scope as string | undefined;

      const session = await getSessionFromParams({ task });

      if (!session) {
        throw new Error(`No session found for task '${task}'`);
      }

      const sessionId = session.session;
      const sessionDir = await resolveSessionDirectory(sessionId);

      const scope =
        scopeRaw && scopeRaw.trim().length > 0
          ? scopeRaw
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;

      const taskId = task.replace(/^mt#/, "").replace(/^#/, "");

      const result = generateSubagentPrompt({
        sessionDir,
        sessionId,
        taskId,
        type,
        instructions,
        scope,
      });

      return { success: true, ...result };
    }),
  };
}
