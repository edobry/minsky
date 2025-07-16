import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { commitChangesFromParams } from "../commit-command";
import { log } from "../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the commit command
 */
export const commitCommandParams: CommandParameterMap = {
  message: {
    schema: z.string().min(1),
    description: "Commit message",
    required: true,
  },
  all: {
    schema: z.boolean(),
    description: "Stage all changes including deletions",
    required: false,
    defaultValue: false,
  },
  amend: {
    schema: z.boolean(),
    description: "Amend the previous commit",
    required: false,
    defaultValue: false,
  },
  noStage: {
    schema: z.boolean(),
    description: "Skip staging changes",
    required: false,
    defaultValue: false,
  },
  repo: {
    schema: z.string(),
    description: REPO_DESCRIPTION,
    required: false,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
};

/**
 * Execute the commit command
 */
export async function executeCommitCommand(
  context: CommandExecutionContext
): Promise<{ commitHash: string; message: string }> {
  const { message, all, amend, noStage, repo, session } = context.parameters;

  const result = await commitChangesFromParams({
    message,
    session,
    repo,
    all,
    amend,
    noStage,
  });

  if (context.debug) {
    log("Commit command executed successfully", { result });
  }

  return result;
} 
