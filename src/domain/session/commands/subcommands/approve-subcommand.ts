import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { approveSessionPr } from "../../session-approval-operations";

/**
 * Session approve subcommand (Task #358 - Updated)
 *
 * Now performs approve-only operation. Use 'session merge' to merge after approval.
 */
export const approveSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;

  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }

  const json = options?.json === true;
  const reviewComment = options?.comment || options?.reviewComment;

  try {
    const result = await approveSessionPr({
      session: sessionId,
      json,
      reviewComment,
    });

    return {
      success: true,
      message: "Session PR approved successfully (use 'session pr merge' to merge)",
      data: result,
    };
  } catch (error) {
    throw new Error(
      `Failed to approve session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
