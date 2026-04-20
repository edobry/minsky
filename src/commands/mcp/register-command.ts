import { Command } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Create the `mcp register` CLI subcommand.
 *
 * Delegates execution to the shared `mcp.register` command definition,
 * keeping the logic DRY while wiring into the existing non-shared `mcp`
 * commander command tree.
 */
export function createRegisterCommand(): Command {
  const registerCmd = new Command("register");
  registerCmd.description("Register Minsky as an MCP server with a supported client");

  registerCmd.option("--client <client>", "The MCP client to register with (e.g., cursor)");
  registerCmd.option("--repo <path>", "Repository path");
  registerCmd.option("--workspace-path <path>", "Workspace path");
  registerCmd.option("--overwrite", "Overwrite existing config", false);

  registerCmd.action(async (options) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("mcp.register");
      if (!commandDef) {
        log.error("[mcp register] Shared command 'mcp.register' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        {
          client: options.client,
          repo: options.repo,
          workspacePath: options.workspacePath,
          overwrite: options.overwrite ?? false,
        },
        { interface: "cli" }
      );

      const typedResult = result as {
        success: boolean;
        message?: string;
        configFilePath?: string;
        client?: string;
      };

      if (typedResult.success) {
        console.log(typedResult.message ?? "Registration successful.");
        if (typedResult.configFilePath) {
          console.log(`Config written to: ${typedResult.configFilePath}`);
        }
      } else {
        console.error(typedResult.message ?? "Registration failed.");
        process.exit(1);
      }
    } catch (error: unknown) {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    }
  });

  return registerCmd;
}
