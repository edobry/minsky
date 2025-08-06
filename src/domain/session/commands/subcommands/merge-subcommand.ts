import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { mergeSessionPr } from "../../session-merge-operations";

/**
 * Session merge subcommand (Task #358)
 *
 * Merges an approved session PR. Requires the session to be approved first.
 */
export const mergeSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;

  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }

  const json = options?.json === true;
  const taskId = options?.task as string | undefined;
  // Cleanup is enabled by default, but can be disabled with --skip-cleanup
  const cleanup = options?.["skip-cleanup"] !== true;

  try {
    const result = await mergeSessionPr({
      session: sessionId,
      task: taskId,
      json,
      cleanupSession: cleanup,
    });

    return {
      success: true,
      message: "Session PR merged successfully",
      data: result,
    };
  } catch (error) {
    throw new Error(
      `Failed to merge session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
