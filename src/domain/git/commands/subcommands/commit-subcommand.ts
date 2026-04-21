import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { commitChangesFromParams } from "../commit-command";
import type { SessionProviderInterface } from "../../../session/index";
import { log } from "../../../../utils/logger";
import { REPO_DESCRIPTION, SESSION_DESCRIPTION } from "../../../../utils/option-descriptions";

/**
 * Parameters for the commit command
 */
export const commitCommandParams = {
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
} satisfies CommandParameterMap;

/**
 * Extended context type that includes parameters for legacy command handlers
 */
interface CommitCommandContext extends CommandExecutionContext {
  parameters: {
    message: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
    repo?: string;
    session?: string;
  };
}

/**
 * Execute the commit command.
 * Resolves session to a repo path before calling the domain function.
 */
export async function executeCommitCommand(
  context: CommitCommandContext,
  sessionProvider: SessionProviderInterface
): Promise<{ commitHash: string; message: string }> {
  const { message, all, amend, noStage, repo, session } = context.parameters;

  // Resolve session to repo path at this boundary
  let resolvedRepo = repo;
  if (session && !resolvedRepo) {
    resolvedRepo = await sessionProvider.getSessionWorkdir(session);
  }

  const result = await commitChangesFromParams({
    message,
    repo: resolvedRepo,
    all,
    amend,
    noStage,
  });

  if (context.debug) {
    log.debug("Commit command executed successfully", { result });
  }

  return result;
}
