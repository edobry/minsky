import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { updateSession } from "../update-command";

export const updateSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args } = params;
  
  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }
  
  try {
    const result = await updateSession(sessionId);
    return { 
      success: true, 
      message: "Session updated successfully",
      data: result 
    };
  } catch (error) {
    throw new Error(`Failed to update session: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
