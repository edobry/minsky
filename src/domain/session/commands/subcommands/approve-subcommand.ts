import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { approveSession } from "../approve-command";

export const approveSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;
  
  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }
  
  const force = options?.force === true;
  
  try {
    const result = await approveSession(sessionId, { force });
    return { 
      success: true, 
      message: "Session approved and merged successfully",
      data: result 
    };
  } catch (error) {
    throw new Error(`Failed to approve session: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
