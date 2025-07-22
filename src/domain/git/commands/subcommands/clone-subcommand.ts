import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { cloneFromParams } from "../clone-command";
import { log } from "../../../../utils/logger";
import {
  SESSION_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the clone command
 */
export const cloneCommandParams: CommandParameterMap = {
  url: {
    schema: z.string().url(),
    description: "URL of the Git repository to clone",
    required: true,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  destination: {
    schema: z.string(),
    description: "Target directory for the clone",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: GIT_BRANCH_DESCRIPTION,
    required: false,
  },
};

/**
 * Execute the clone command
 */
export async function executeCloneCommand(
  parameters: { [K in keyof typeof cloneCommandParams]: z.infer<typeof cloneCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<{ workdir: string; session: string }> {
  const { url, session, destination, branch } = parameters;

  const result = await cloneFromParams({
    url,
    workdir: destination || process.cwd(),
    session,
    branch,
  });

  if (context.debug) {
    log.debug("Clone command executed successfully", { result });
  }

  return result;
} 
