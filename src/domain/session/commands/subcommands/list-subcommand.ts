import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { listSessionsFromParams } from "../list-command";
import { log } from "../../../../../../utils/logger";

/**
 * Parameters for the session list command
 */
export const sessionListCommandParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Execute the session list command
 */
export async function executeSessionListCommand(
  parameters: { [K in keyof typeof sessionListCommandParams]: z.infer<typeof sessionListCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<any[]> {
  const { repo, json } = parameters;

  const result = await listSessionsFromParams({
    repo,
    json,
  });

  if (context.debug) {
    log.debug("Session list command executed successfully", { result });
  }

  return result;
} 
