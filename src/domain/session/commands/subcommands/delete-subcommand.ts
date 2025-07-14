import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { deleteSession } from "../delete-command";

export const deleteSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args } = params;
  
  if (!args || args.length === 0) {
    throw new Error("Session ID is required");
  }
  
  const sessionId = args[0];
  
  try {
    await deleteSession(sessionId);
    return { success: true, message: `Session ${sessionId} deleted successfully` };
  } catch (error) {
    throw new Error(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
