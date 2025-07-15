import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { reviewSession } from "../review-command";

export const reviewSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args } = params;
  
  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }
  
  try {
    const review = await reviewSession(sessionId);
    return { 
      success: true, 
      data: review 
    };
  } catch (error) {
    throw new Error(`Failed to review session: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
