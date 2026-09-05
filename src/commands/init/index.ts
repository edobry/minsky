/**
 * `minsky init` top-level CLI command.
 *
 * Delegates execution to the shared `init` command definition in the registry,
 * keeping logic DRY while presenting `init` as a top-level CLI command rather
 * than a subcommand nested under an INIT category wrapper.
 */
import { Command } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { RULE_FORMAT_DESCRIPTION } from "../../utils/option-descriptions";

export function createInitCommand(): Command {
  const cmd = new Command("init");
  cmd.description("Initialize a project for Minsky");

  // Mirror all options from the shared command definition (init.ts)
  cmd.option("--repo <path>", "Repository path to initialize");
  cmd.option("--backend <string>", "Backend type (available: github, minsky)");
  cmd.option("--overwrite", "Overwrite existing resources", false);
  cmd.option("--workspace-path <path>", "Workspace path");
  cmd.option("--github-owner <string>", "GitHub repository owner");
  cmd.option("--github-repo <string>", "GitHub repository name");
  cmd.option("--rule-format <string>", RULE_FORMAT_DESCRIPTION);
  cmd.option("--mcp <string>", "Enable/disable MCP configuration");
  cmd.option("--mcp-transport <string>", "MCP transport type (stdio, sse, httpStream)");
  cmd.option("--mcp-port <string>", "Port for MCP network transports");
  cmd.option("--mcp-host <string>", "Host for MCP network transports");
  // mt#4872 SC4. These MUST be mirrored here as well as in the shared
  // definition: the INIT category is hidden from CLI auto-generation
  // (`init-customizations.ts`) because this file registers `init` as a
  // top-level command, so a parameter added only to the shared registry
  // reaches the MCP surface and never appears on the CLI at all. Same
  // parallel-implementation shape as `compileCheckTargets` in mt#4866 — caught
  // here by regenerating the completion manifest and finding the flags absent.

  cmd.option(
    "--enable <ids>",
    "Rule ids to enable, comma-separated (non-interactive selection; see `minsky rules list`)"
  );
  cmd.option(
    "--disable <ids>",
    "Rule ids to decline, comma-separated (non-interactive selection; base rules cannot be declined)"
  );

  cmd.action(async (options) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("init");
      if (!commandDef) {
        console.error("Shared command 'init' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        {
          repo: options.repo,
          backend: options.backend,
          overwrite: options.overwrite ?? false,
          workspacePath: options.workspacePath,
          githubOwner: options.githubOwner,
          githubRepo: options.githubRepo,
          ruleFormat: options.ruleFormat,
          mcp: options.mcp,
          mcpTransport: options.mcpTransport,
          mcpPort: options.mcpPort,
          mcpHost: options.mcpHost,
          enable: options.enable,
          disable: options.disable,
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
