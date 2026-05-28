/**
 * `minsky setup` top-level CLI command.
 *
 * Delegates execution to the shared `setup` command definition in the registry,
 * keeping logic DRY while presenting `setup` as a top-level CLI command rather
 * than a subcommand nested under an INIT category wrapper.
 */
import { Command, InvalidArgumentError } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";

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

  cmd.addCommand(createSetupGithubAppCommand());

  return cmd;
}

function createSetupGithubAppCommand(): Command {
  const cmd = new Command("github-app");
  cmd.description(
    "Create and install a GitHub App via the manifest flow (or guided wizard fallback), or update an existing App's events/permissions"
  );

  cmd.requiredOption("--name <name>", "App name (also used as file prefix under outputDir)");
  cmd.option(
    "--repo <owner/repo>",
    "Target repo in owner/repo form (required for create, not for --update)"
  );
  cmd.option("--via <provisioner>", "Provisioner: manifest (default) or wizard");
  cmd.option("--output-dir <path>", "Where to write credentials (default: ~/.config/minsky)");
  cmd.option("--force", "Re-provision even if credentials already exist", false);
  cmd.option("--update", "Update an existing App's events/permissions via PATCH /app", false);
  cmd.option(
    "--execute",
    "Apply changes (without this flag, --update shows a dry-run preview)",
    false
  );
  cmd.option(
    "--permissions <k:v,...>",
    "Comma-separated k:v permissions (default: pull_requests:write,contents:read,metadata:read)"
  );
  cmd.option("--events <e1,e2,...>", "Comma-separated GitHub event names");
  cmd.option("--webhook-url <url>", "Webhook URL to prefill in hook_attributes");
  cmd.option(
    "--inactive",
    "Create with hook_attributes.active=false (no webhook deliveries)",
    false
  );
  cmd.option(
    "--port <n>",
    "Local callback port for the manifest flow (1-65535; default: 9847)",
    (v) => {
      const n = Number(v);
      if (!Number.isInteger(n)) {
        throw new InvalidArgumentError(`--port must be an integer, got "${v}".`);
      }
      return n;
    }
  );
  cmd.option(
    "--api-base-url <url>",
    "GitHub API base URL for the wizard (default: https://api.github.com; set for GHE)"
  );
  cmd.option(
    "--web-base-url <url>",
    "GitHub web base URL for the wizard (default: https://github.com; set for GHE)"
  );

  cmd.action(async (options) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("setup.github-app");
      if (!commandDef) {
        console.error("Shared command 'setup.github-app' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        {
          name: options.name,
          repo: options.repo,
          via: options.via,
          outputDir: options.outputDir,
          force: options.force ?? false,
          update: options.update ?? false,
          execute: options.execute ?? false,
          permissions: options.permissions,
          events: options.events,
          webhookUrl: options.webhookUrl,
          inactive: options.inactive ?? false,
          port: options.port,
          apiBaseUrl: options.apiBaseUrl,
          webBaseUrl: options.webBaseUrl,
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
