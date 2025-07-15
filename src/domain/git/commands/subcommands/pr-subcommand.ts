import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { createPullRequestFromParams } from "../pr-command";
import { log } from "../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
  TASK_ID_DESCRIPTION,
  DEBUG_DESCRIPTION,
  NO_STATUS_UPDATE_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the pr command
 */
export const prCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  repo: {
    schema: z.string(),
    description: REPO_DESCRIPTION,
    required: false,
  },
  branch: {
    schema: z.string(),
    description: GIT_BRANCH_DESCRIPTION,
    required: false,
  },
  task: {
    schema: z.string(),
    description: TASK_ID_DESCRIPTION,
    required: false,
  },
  debug: {
    schema: z.boolean().default(false),
    description: DEBUG_DESCRIPTION,
    required: false,
  },
  noStatusUpdate: {
    schema: z.boolean().default(false),
    description: NO_STATUS_UPDATE_DESCRIPTION,
    required: false,
  },
  preview: {
    schema: z.boolean(),
    description: "Preview the PR without creating it",
    required: false,
    defaultValue: false,
  },
};

/**
 * Execute the pr command
 */
export async function executePrCommand(
  parameters: { [K in keyof typeof prCommandParams]: z.infer<typeof prCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<{ markdown: string; statusUpdateResult?: any }> {
  const { session, repo, branch, task, debug, noStatusUpdate } = parameters;

  const result = await createPullRequestFromParams({
    session,
    repo,
    branch,
    taskId: task,
    debug,
    noStatusUpdate,
  });

  if (context.debug || debug) {
    log.debug("PR command executed successfully", { result });
  }

  return result;
} 
