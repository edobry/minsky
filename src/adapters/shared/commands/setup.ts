/**
 * Setup command — developer-local initialization.
 *
 * Reads the existing project config and derives local configuration
 * (MCP registration + local config file). Unlike `init`, this works
 * with an already-initialized project without requiring the full config
 * system to be initialized.
 */

import { z } from "zod";
import { select, confirm, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import { performSetup } from "@minsky/domain/setup";
import { applyHarnessSettings } from "@minsky/domain/setup/harness-settings";
import { detectInstalledClients } from "@minsky/domain/runtime/harness-detection";
import { ValidationError } from "@minsky/domain/errors/index";
import { CommonParameters, composeParams } from "../common-parameters";
import { isInteractive } from "../../../utils/interactive";
import { runInteractiveSetupDb } from "./setup-db";

const setupParams = composeParams(
  {
    repo: {
      schema: z.string().optional(),
      description: "Repository path to set up",
      required: false,
    },
    workspacePath: CommonParameters.workspace,
    overwrite: CommonParameters.overwrite,
  },
  {
    client: {
      schema: z.string().optional(),
      description: "MCP client to register with (e.g. cursor)",
      required: false,
    },
    skipAgentSettings: {
      schema: z.boolean().optional(),
      description: "Skip applying recommended agent performance settings",
      required: false,
    },
    connectionString: {
      schema: z.string().optional(),
      description:
        "Postgres connection string, used only if no connection can be inherited from " + // gitleaks:allow — placeholder, not a real credential
        "existing config (otherwise captured via the setup db wizard)",
      required: false,
    },
    yes: {
      schema: z.boolean().optional(),
      description: "Skip the DB-setup confirmation prompt if the interactive wizard runs",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Test seam: dependency overrides for `setup`. Production callers leave this undefined;
 * tests inject mocks to avoid touching the filesystem, config loader, or a live DB.
 */
export interface SetupCommandDeps {
  performSetup?: typeof performSetup;
  runInteractiveSetupDb?: typeof runInteractiveSetupDb;
}

export function registerSetupCommands(deps: SetupCommandDeps = {}) {
  const performSetupFn = deps.performSetup ?? performSetup;
  const runInteractiveSetupDbFn = deps.runInteractiveSetupDb ?? runInteractiveSetupDb;

  // When called with explicit deps (i.e., from tests), allow overwrite so each test
  // re-registers cleanly. Production calls pass no deps and register exactly once.
  const allowOverwrite =
    deps.performSetup !== undefined || deps.runInteractiveSetupDb !== undefined;

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup",
      category: CommandCategory.INIT,
      name: "setup",
      description:
        "Set up developer-local configuration for Minsky (MCP registration + local config + " +
        "DB connection inheritance)",
      parameters: setupParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          const repoPath = params.repo || params.workspacePath || process.cwd();
          const overwrite = params.overwrite ?? false;

          // Determine which client to register with
          let client = params.client;
          if (!client) {
            const installedClients = detectInstalledClients();

            if (installedClients.length === 0) {
              // No known clients detected — default to cursor
              client = "cursor";
            } else if (installedClients.length === 1) {
              // Only one client detected — use it automatically
              client = installedClients[0];
            } else {
              // Multiple clients detected — prompt if interactive
              if (!isInteractive()) {
                // eslint-disable-next-line custom/no-validation-error-in-execute
                throw new ValidationError(
                  `Multiple MCP clients detected (${installedClients.join(", ")}). Use --client to specify one.`
                );
              }

              const selectedClient = await select({
                message: "Select an MCP client to register Minsky with:",
                options: installedClients.map((c) => ({ value: c, label: c })),
                initialValue: installedClients[0],
              });

              if (isCancel(selectedClient)) {
                cancel("Setup cancelled.");
                return { success: false, message: "Setup cancelled by user." };
              }

              client = selectedClient as string;
            }
          }

          const result = await performSetupFn({ repoPath, client, overwrite });

          // Apply recommended agent performance settings unless skipped
          const agentSettingsMessages: string[] = [];
          if (!params.skipAgentSettings) {
            // Dry-run first to see what would change
            const preview = await applyHarnessSettings({ dryRun: true });
            const toApply = preview.filter((r) => r.status === "applied");

            if (toApply.length > 0 && isInteractive()) {
              // Show what will be changed and prompt
              const changeLines = toApply.flatMap((r) =>
                r.changes.map(
                  (c) =>
                    `  ${r.harness}: ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`
                )
              );
              const shouldApply = await confirm({
                message: `Apply recommended agent performance settings?\n${changeLines.join("\n")}`,
                initialValue: true,
              });

              if (!isCancel(shouldApply) && shouldApply) {
                const applied = await applyHarnessSettings({ dryRun: false });
                for (const r of applied) {
                  if (r.status === "applied") {
                    agentSettingsMessages.push(
                      `Agent settings applied for ${r.harness} (${r.settingsPath})`
                    );
                  }
                }
              } else {
                agentSettingsMessages.push("Agent settings skipped.");
              }
            } else {
              // Non-interactive or nothing to apply
              for (const r of preview) {
                if (r.status === "already-configured") {
                  agentSettingsMessages.push(`Agent settings already configured for ${r.harness}.`);
                } else if (r.status === "not-detected") {
                  // Silently skip undetected harnesses
                }
              }
            }
          }

          const agentSettingsSuffix =
            agentSettingsMessages.length > 0 ? `\n${agentSettingsMessages.join("\n")}` : "";

          // DB-connection inheritance/confirmation (mt#2502): reuse an already-configured
          // Postgres connection when the config loader resolves one (typically left in user
          // config by a prior project); otherwise fall into the interactive `setup db` wizard
          // inline so a new project on the unified instance needs zero database thought.
          // `setup db` remains available standalone for explicit/non-interactive use.
          const dbMessages: string[] = [];
          const { dbConnection } = result;
          if (dbConnection.found && dbConnection.connectivity?.ok) {
            dbMessages.push(
              `Using existing Postgres connection from ${dbConnection.source} (connectivity verified).`
            );
          } else {
            if (dbConnection.found && dbConnection.connectivity && !dbConnection.connectivity.ok) {
              dbMessages.push(
                `Found a Postgres connection in ${dbConnection.source}, but it did not pass a ` +
                  `connectivity check (${dbConnection.connectivity.error ?? "unknown error"}) — ` +
                  `falling back to interactive database setup.`
              );
            }
            const dbResult = await runInteractiveSetupDbFn({
              connectionString: params.connectionString,
              yes: params.yes,
            });
            dbMessages.push(dbResult.message);
          }
          const dbSuffix = dbMessages.length > 0 ? `\n${dbMessages.join("\n")}` : "";

          return {
            success: result.success,
            message: result.message + agentSettingsSuffix + dbSuffix,
            localConfigPath: result.localConfigPath,
            harnessConfigPath: result.harnessConfigPath,
            client: result.client,
            dbConnection: result.dbConnection,
          };
        } catch (error: unknown) {
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    }),
    { allowOverwrite }
  );
}
