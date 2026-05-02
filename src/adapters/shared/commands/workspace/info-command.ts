/**
 * workspace.info Command
 *
 * Returns information about the current workspace context (main vs session,
 * paths, active backends).  Marked requiresSetup: false so it is callable from
 * any directory, including uninitialised ones and fresh session workspaces.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../../command-registry";
import { getWorkspaceInfo } from "../../../../domain/workspace/info";

const workspaceInfoParams = {
  cwd: {
    schema: z.string().optional(),
    description:
      "Directory to inspect. Defaults to the server's process.cwd(). " +
      "Pass an explicit path when calling from a different working directory.",
    required: false,
  },
};

const workspaceInfoCommand = defineCommand({
  id: "workspace.info",
  category: CommandCategory.WORKSPACE,
  name: "info",
  description:
    "Returns information about the current workspace context (main vs session, paths, " +
    "active backends). Call this first to inform subsequent tool calls.",
  parameters: workspaceInfoParams,
  requiresSetup: false,
  execute: async (params) => {
    const info = await getWorkspaceInfo(params.cwd);
    return { success: true, ...info };
  },
});

/**
 * Register all workspace commands in the shared command registry.
 */
export function registerWorkspaceCommands(): void {
  sharedCommandRegistry.registerCommand(workspaceInfoCommand);
}
