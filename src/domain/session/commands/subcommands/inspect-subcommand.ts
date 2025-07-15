import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { inspectCurrentSession } from "../inspect-command";

export const inspectSessionSubcommand: CommandExecutionHandler = async (params) => {
  try {
    const sessionInfo = await inspectCurrentSession();
    return { 
      success: true, 
      data: sessionInfo 
    };
  } catch (error) {
    throw new Error(`Failed to inspect session: ${error instanceof Error ? error.message : String(error)}`);
  }
}; 
