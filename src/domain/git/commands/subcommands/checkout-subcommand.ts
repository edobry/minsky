import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { checkoutFromParams } from "../checkout-command";
import { getSharedSessionProvider } from "../../../session/session-provider-cache";
import type { SessionProviderInterface } from "../../../session/index";
import { log } from "../../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
} from "../../../../utils/option-descriptions";

/**
 * Parameters for the checkout command
 */
export const checkoutCommandParams = {
  branch: {
    schema: z.string(),
    description: GIT_BRANCH_DESCRIPTION,
    required: true,
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
    description: "Preview the checkout without performing it",
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
    description: "Strategy for handling checkout conflicts",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Execute the checkout command
 */
export async function executeCheckoutCommand(
  parameters: {
    [K in keyof typeof checkoutCommandParams]: z.infer<(typeof checkoutCommandParams)[K]["schema"]>;
  },
  context: CommandExecutionContext,
  sessionProvider?: SessionProviderInterface,
): Promise<unknown> {
  const { branch, session, repo, preview, autoResolve, conflictStrategy } = parameters;

  const resolvedSessionProvider = sessionProvider ?? (await getSharedSessionProvider());
  const result = await checkoutFromParams(
    {
      branch,
      session,
      repo,
      preview,
      autoResolve,
      conflictStrategy,
    },
    { sessionProvider: resolvedSessionProvider }
  );

  if (context.debug) {
    log.debug("Checkout command executed successfully", { result });
  }

  return result;
}