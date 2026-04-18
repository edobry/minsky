import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { sessionPr } from "../pr-command";
import { getSharedSessionProvider } from "../../session-provider-cache";
import type { SessionProviderInterface } from "../../index";
import { createGitService } from "../../../git";

export const prSessionSubcommand: CommandExecutionHandler = async (params) => {
  const { args, options } = params;

  let sessionId: string | undefined;
  if (args && args.length > 0) {
    sessionId = args[0];
  }

  const noStatusUpdate = options?.["no-status-update"] === true;

  try {
    const sessionDB = await getSharedSessionProvider();
    const gitService = createGitService();
    const prDescription = await sessionPr(
      {
        session: sessionId,
        noStatusUpdate,
        title: "",
      } as Parameters<typeof sessionPr>[0],
      { sessionDB, gitService }
    );
    return {
      success: true,
      data: { prDescription },
    };
  } catch (error) {
    throw new Error(
      `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Create the PR subcommand handler with optional injected session provider.
 * Use this factory when you want to pass a provider from a DI container.
 */
export function createPrSessionSubcommand(
  sessionProvider?: SessionProviderInterface,
): CommandExecutionHandler {
  return async (params) => {
    const { args, options } = params;

    let sessionId: string | undefined;
    if (args && args.length > 0) {
      sessionId = args[0];
    }

    const noStatusUpdate = options?.["no-status-update"] === true;

    try {
      const sessionDB = sessionProvider ?? (await getSharedSessionProvider());
      const gitService = createGitService();
      const prDescription = await sessionPr(
        {
          session: sessionId,
          noStatusUpdate,
          title: "",
        } as Parameters<typeof sessionPr>[0],
        { sessionDB, gitService }
      );
      return {
        success: true,
        data: { prDescription },
      };
    } catch (error) {
      throw new Error(
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
