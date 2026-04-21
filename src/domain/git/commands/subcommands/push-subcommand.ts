import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { pushFromParams } from "../push-command";
import { log } from "../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_REMOTE_DESCRIPTION,
  GIT_FORCE_DESCRIPTION,
  DEBUG_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the push command
 */
export const pushCommandParams = {
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
  remote: {
    schema: z.string(),
    description: GIT_REMOTE_DESCRIPTION,
    required: false,
    defaultValue: "origin",
  },
  force: {
    schema: z.boolean(),
    description: GIT_FORCE_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: DEBUG_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

/**
 * Execute the push command
 */
export async function executePushCommand(
  parameters: {
    [K in keyof typeof pushCommandParams]: z.infer<(typeof pushCommandParams)[K]["schema"]>;
  },
  context: CommandExecutionContext,
  sessionProvider?: { getSessionWorkdir(session: string): Promise<string> }
): Promise<{ workdir: string; pushed: boolean }> {
  const { repo, session, remote, force, debug } = parameters;

  // Resolve session to repo path at this boundary
  let resolvedRepo = repo;
  if (session && !resolvedRepo && sessionProvider) {
    resolvedRepo = await sessionProvider.getSessionWorkdir(session);
  }

  const result = await pushFromParams({
    repo: resolvedRepo,
    remote,
    force,
    debug,
  });

  if (context.debug || debug) {
    log.debug("Push command executed successfully", { result });
  }

  return result;
}
