/**
 * `minsky setup` top-level CLI command.
 *
 * Delegates execution to the shared `setup` command definition in the registry,
 * keeping logic DRY while presenting `setup` as a top-level CLI command rather
 * than a subcommand nested under an INIT category wrapper.
 */
import { Command, InvalidArgumentError, type OptionValues } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";

/**
 * A subcommand's own options merged with its ancestors'.
 *
 * `setup` declares `--repo`, `--connection-string` and `--yes`, and its
 * subcommands declare options of the same names. Commander binds a flag to the
 * command that DECLARES it — the outermost one — so `setup db
 * --connection-string X` lands in the PARENT's opts and the subcommand's own
 * `options.connectionString` is undefined. Nothing errors: the flag parses, the
 * subcommand's `--help` still advertises it, and the action proceeds with the
 * value unset.
 *
 * `optsWithGlobals()` is commander's documented accessor for exactly this case
 * (`commander/typings/index.d.ts`), and reading it is what makes a flag work
 * from either position. The `typeof` guard keeps these actions callable with a
 * plain object in tests and on any commander that predates the accessor.
 *
 * Which names actually collide is not a matter of reading this file carefully —
 * `scripts/audit-option-shadowing.ts` computes it from the generated command
 * manifest, and a test pins the answer (mt#4076).
 */
export function mergedSetupOpts(options: OptionValues, command?: Command): OptionValues {
  return typeof command?.optsWithGlobals === "function" ? command.optsWithGlobals() : options;
}

export function createSetupCommand(): Command {
  const cmd = new Command("setup");
  cmd.description("Set up developer-local configuration for Minsky");

  // Mirror all options from the shared command definition (setup.ts)
  cmd.option("--client <client>", "MCP client to register with (e.g. cursor)");
  cmd.option("--overwrite", "Overwrite existing config", false);
  cmd.option("--repo <path>", "Repository path");
  cmd.option("--workspace-path <path>", "Workspace path");
  cmd.option(
    "--connection-string <url>",
    "Postgres connection string, used only if no connection can be inherited from " +
      "existing config (otherwise captured via the setup db wizard)"
  );
  cmd.option(
    "--yes",
    "Skip the DB-setup confirmation prompt if the interactive wizard runs",
    false
  );

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
          connectionString: options.connectionString,
          yes: options.yes ?? false,
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
  cmd.addCommand(createSetupDbCommand());
  cmd.addCommand(createSetupLocalHttpCommand());

  return cmd;
}

function createSetupLocalHttpCommand(): Command {
  const cmd = new Command("local-http");
  cmd.description(
    "Point Claude Code's Minsky MCP entries at the shared local daemon via the stdio shim " +
      "(dry-run by default; --revert restores the previous config and stops the daemon)"
  );

  cmd.option("--execute", "Apply the change (without it, the plan is printed only)", false);
  cmd.option(
    "--revert",
    "Restore the most recent backup of each config and stop the local daemon",
    false
  );
  cmd.option("--url <url>", "Daemon MCP URL for the shim (default http://127.0.0.1:48765/mcp)");
  cmd.option("--repo <path>", "Project root whose .mcp.json is scanned (default: cwd)");

  cmd.action(async (options, command: Command) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("setup.local-http");
      if (!commandDef) {
        console.error("Shared command 'setup.local-http' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        buildSetupLocalHttpParams(mergedSetupOpts(options, command)),
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

/**
 * The params each `setup` subcommand hands its shared-command definition.
 *
 * Split out from the actions so the option-name → param-name mapping is
 * reachable by a test that drives the REAL command tree, rather than one that
 * patches `sharedCommandRegistry` to observe the call. The mapping is where the
 * mt#4076 defect lived — a shadowed flag arrives here as `undefined` — so it is
 * the thing worth asserting, and it holds no logic beyond defaulting.
 *
 * Exported for that test, not as an API for other modules: nothing outside this
 * file and its test should build these, and each shape is owned by its shared
 * command definition rather than by this adapter.
 */
export interface SetupDbParams {
  connectionString: string | undefined;
  yes: boolean;
}

export interface SetupGithubAppParams {
  name: string | undefined;
  repo: string | undefined;
  via: string | undefined;
  outputDir: string | undefined;
  force: boolean;
  update: boolean;
  execute: boolean;
  permissions: string | undefined;
  events: string | undefined;
  webhookUrl: string | undefined;
  inactive: boolean;
  /** Already coerced to a number by the option's own parser. */
  port: number | undefined;
  apiBaseUrl: string | undefined;
  webBaseUrl: string | undefined;
}

export interface SetupLocalHttpParams {
  execute: boolean;
  revert: boolean;
  url: string | undefined;
  repo: string | undefined;
}

export function buildSetupDbParams(merged: OptionValues): SetupDbParams {
  return {
    connectionString: merged.connectionString,
    yes: merged.yes ?? false,
  };
}

export function buildSetupGithubAppParams(merged: OptionValues): SetupGithubAppParams {
  return {
    name: merged.name,
    repo: merged.repo,
    via: merged.via,
    outputDir: merged.outputDir,
    force: merged.force ?? false,
    update: merged.update ?? false,
    execute: merged.execute ?? false,
    permissions: merged.permissions,
    events: merged.events,
    webhookUrl: merged.webhookUrl,
    inactive: merged.inactive ?? false,
    port: merged.port,
    apiBaseUrl: merged.apiBaseUrl,
    webBaseUrl: merged.webBaseUrl,
  };
}

export function buildSetupLocalHttpParams(merged: OptionValues): SetupLocalHttpParams {
  return {
    execute: merged.execute ?? false,
    revert: merged.revert ?? false,
    url: merged.url,
    repo: merged.repo,
  };
}

function createSetupDbCommand(): Command {
  const cmd = new Command("db");
  cmd.description(
    "Configure Postgres persistence: capture a connection string, write config, run migrations, and verify connectivity (Docker / Supabase / bring-your-own)"
  );

  cmd.option(
    "--connection-string <url>",
    "Postgres connection string (required in non-interactive mode; otherwise captured via the wizard)"
  );
  cmd.option("--yes", "Skip the confirmation prompt before writing config", false);

  cmd.action(async (options, command: Command) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("setup.db");
      if (!commandDef) {
        console.error("Shared command 'setup.db' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        buildSetupDbParams(mergedSetupOpts(options, command)),
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
  cmd.option(
    "--update",
    "Show drift between an existing App's live and requested events/permissions, with a link " +
      "to the settings page to fix it (GitHub has no API to apply this)",
    false
  );
  cmd.option(
    "--execute",
    "No effect with --update (there is no API to apply an events/permissions change); " +
      "accepted for backward compatibility",
    false
  );
  cmd.option(
    "--permissions <k:v,...>",
    "Comma-separated k:v permissions (default: pull_requests:write,contents:write,metadata:read " +
      "— contents:write is required for session_commit's App-token push, mt#1477/mt#3210)"
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

  cmd.action(async (options, command: Command) => {
    try {
      const commandDef = sharedCommandRegistry.getCommand("setup.github-app");
      if (!commandDef) {
        console.error("Shared command 'setup.github-app' not found in registry");
        process.exit(1);
      }

      const result = await commandDef.execute(
        buildSetupGithubAppParams(mergedSetupOpts(options, command)),
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
