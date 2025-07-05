import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { getSessionDirectory } from "../dir-command";

export const dirSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args } = params;
  
  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }
  
  try {
    const sessionDir = await getSessionDirectory(sessionId);
    return { success: true, data: { sessionDirectory: sessionDir } };
  } catch (error) {
    throw new Error(`Failed to get session directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
