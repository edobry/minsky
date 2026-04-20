/**
 * `minsky setup` top-level CLI command.
 *
 * Delegates execution to the shared `setup` command definition in the registry,
 * keeping logic DRY while presenting `setup` as a top-level CLI command rather
 * than a subcommand nested under an INIT category wrapper.
 */
import { Command } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "../../errors/index";

export function createSetupCommand(): Command {
  const cmd = new Command("setup");
  cmd.description("Set up developer-local configuration for Minsky");

  // Mirror all options from the shared command definition (setup.ts)
  cmd.option("--client <client>", "MCP client to register with (e.g. cursor)");
  cmd.option("--overwrite", "Overwrite existing config", false);
  cmd.option("--repo <path>", "Repository path");
  cmd.option("--workspace-path <path>", "Workspace path");

  cmd.action(async (options) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("setup");
      if (!commandDef) {
        console.error("Shared command 'setup' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        {
          client: options.client,
          overwrite: options.overwrite ?? false,
          repo: options.repo,
          workspacePath: options.workspacePath,
        },
        { interface: "cli" }
      );

      const typed = result as { success: boolean; message?: string };
      if (typed.message) console.log(typed.message);
      if (!typed.success) process.exit(1);
    } catch (error: unknown) {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    }
  });

  return cmd;
}
