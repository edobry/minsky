/**
 * Setup command — developer-local initialization.
 *
 * Reads the existing project config and derives local configuration
 * (MCP registration + local config file). Unlike `init`, this works
 * with an already-initialized project without requiring the full config
 * system to be initialized.
 */

import { z } from "zod";
import { select, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import { performSetup } from "../../../domain/setup";
import { detectInstalledClients } from "../../../domain/runtime/harness-detection";
import { ValidationError } from "../../../errors/index";
import { CommonParameters, composeParams } from "../common-parameters";
import { isInteractive } from "../../../utils/interactive";

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
  }
) satisfies CommandParameterMap;

export function registerSetupCommands() {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup",
      category: CommandCategory.INIT,
      name: "setup",
      description:
        "Set up developer-local configuration for Minsky (MCP registration + local config)",
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

          const result = await performSetup({ repoPath, client, overwrite });

          return {
            success: result.success,
            message: result.message,
            localConfigPath: result.localConfigPath,
            harnessConfigPath: result.harnessConfigPath,
            client: result.client,
          };
        } catch (error: unknown) {
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    })
  );
}
