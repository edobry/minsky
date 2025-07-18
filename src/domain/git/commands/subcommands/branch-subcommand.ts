import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { branchFromParams } from "../branch-command";
import { log } from "../../../../../utils/logger";
import {
  SESSION_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the branch command
 */
export const branchCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: true,
  },
  name: {
    schema: z.string(),
    description: "Name of the branch to create",
    required: true,
  },
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts before creating the branch",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
  },
};

/**
 * Execute the branch command
 */
export async function executeBranchCommand(
  parameters: { [K in keyof typeof branchCommandParams]: z.infer<typeof branchCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<{ workdir: string; branch: string }> {
  const { session, name } = parameters;

  const result = await branchFromParams({
    session,
    name,
  });

  if (context.debug) {
    log.debug("Branch command executed successfully", { result });
  }

  return result;
} 
