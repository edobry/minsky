import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { createSessionPR } from "../pr-command";

export const prSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;
  
  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }
  
  const noStatusUpdate = options?.["no-status-update"] === true;
  
  try {
    const prDescription = await createSessionPR(sessionId, { noStatusUpdate });
    return { 
      success: true, 
      data: { prDescription }
    };
  } catch (error) {
    throw new Error(`Failed to create PR: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
