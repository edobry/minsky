import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { getSessionFromParams } from "../get-command";
import { log } from "../../../../../../utils/logger";

/**
 * Parameters for the session get command
 */
export const sessionGetCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
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
 * Execute the session get command
 */
export async function executeSessionGetCommand(
  parameters: { [K in keyof typeof sessionGetCommandParams]: z.infer<typeof sessionGetCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<any> {
  const { name, task, repo, json } = parameters;

  const result = await getSessionFromParams({
    name,
    task,
    repo,
    json,
  });

  if (context.debug) {
    log.debug("Session get command executed successfully", { result });
  }

  return result;
} 
