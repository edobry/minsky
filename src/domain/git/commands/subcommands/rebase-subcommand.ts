import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { rebaseFromParams } from "../rebase-command";
import { log } from "../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the rebase command
 */
export const rebaseCommandParams: CommandParameterMap = {
  baseBranch: {
    schema: z.string(),
    description: "Base branch to rebase onto",
    required: true,
  },
  featureBranch: {
    schema: z.string(),
    description: "Feature branch to rebase (defaults to current branch)",
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
    description: "Preview the rebase without performing it",
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
    description: "Strategy for handling rebase conflicts",
    required: false,
  },
};

/**
 * Execute the rebase command
 */
export async function executeRebaseCommand(
  parameters: { [K in keyof typeof rebaseCommandParams]: z.infer<typeof rebaseCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<any> {
  const { baseBranch, featureBranch, session, repo, preview, autoResolve, conflictStrategy } = parameters;

  const result = await rebaseFromParams({
    baseBranch,
    featureBranch,
    session,
    repo,
    preview,
    autoResolve,
    conflictStrategy,
  });

  if (context.debug) {
    log.debug("Rebase command executed successfully", { result });
  }

  return result;
} 
