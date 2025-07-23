import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { approveSessionImpl } from "../../session-approve-operations";

export const approveSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;

  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }

  const noStash = options?.noStash === true;
  const json = options?.json === true;

  try {
    const result = await approveSessionImpl({
      session: sessionId,
      json,
      noStash,
    });
    return {
      success: true,
      message: "Session approved and merged successfully",
      data: result,
    };
  } catch (error) {
    throw new Error(
      `Failed to approve session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
