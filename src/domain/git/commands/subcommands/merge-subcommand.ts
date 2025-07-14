import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { mergeFromParams } from "../merge-command";
import { log } from "../../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the merge command
 */
export const mergeCommandParams: CommandParameterMap = {
  sourceBranch: {
    schema: z.string(),
    description: "Branch to merge from",
    required: true,
  },
  targetBranch: {
    schema: z.string(),
    description: "Branch to merge into (defaults to current branch)",
    required: false,
  },
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
  preview: {
    schema: z.boolean(),
    description: "Preview the merge without performing it",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
  },
  conflictStrategy: {
    schema: z.string(),
    description: "Strategy for handling merge conflicts",
    required: false,
  },
};

/**
 * Execute the merge command
 */
export async function executeMergeCommand(
  parameters: { [K in keyof typeof mergeCommandParams]: z.infer<typeof mergeCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<any> {
  const { sourceBranch, targetBranch, session, repo, preview, autoResolve, conflictStrategy } = parameters;

  const result = await mergeFromParams({
    sourceBranch,
    targetBranch,
    session,
    repo,
    preview,
    autoResolve,
    conflictStrategy,
  });

  if (context.debug) {
    log.debug("Merge command executed successfully", { result });
  }

  return result;
} 
