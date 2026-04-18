import { CommandExecutionHandler } from "../../../../adapters/shared/command-registry";
import { sessionPr } from "../pr-command";
import type { SessionProviderInterface } from "../../index";
import { createGitService } from "../../../git";

/**
 * Create the PR subcommand handler with injected session provider.
 */
export function createPrSessionSubcommand(
  sessionProvider: SessionProviderInterface
): CommandExecutionHandler {
  return async (params) => {
    const { args, options } = params;

    let sessionId: string | undefined;
    if (args && args.length > 0) {
      sessionId = args[0];
    }

    const noStatusUpdate = options?.["no-status-update"] === true;

    try {
      const gitService = createGitService();
      const prDescription = await sessionPr(
        {
          session: sessionId,
          noStatusUpdate,
          title: "",
        } as Parameters<typeof sessionPr>[0],
        { sessionDB: sessionProvider, gitService }
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
