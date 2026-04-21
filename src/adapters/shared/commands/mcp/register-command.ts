/**
 * Shared MCP Register Command
 *
 * Registers Minsky as an MCP server with a supported client (e.g., Cursor, Claude Desktop).
 * Reads the project's MCP config from `.minsky/config.yaml` and generates
 * the appropriate harness-specific config file.
 */

import { z } from "zod";
import { existsSync } from "fs";
import * as path from "path";
import { select, isCancel, cancel, confirm } from "@clack/prompts";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../../command-registry";
import { CommonParameters, composeParams } from "../../common-parameters";
import { isInteractive } from "../../../../utils/interactive";
import { detectInstalledClients } from "../../../../domain/runtime/harness-detection";
import { registerWithClient, getRegistrar } from "../../../../domain/mcp/registration";
import { loadProjectConfiguration } from "../../../../domain/configuration/sources/project";
import { ValidationError, getErrorMessage } from "../../../../errors/index";
import type { McpConfig } from "../../../../domain/configuration/schemas/mcp";

const mcpRegisterParams = composeParams(
  {
    repo: CommonParameters.repo,
    workspacePath: CommonParameters.workspace,
    overwrite: CommonParameters.overwrite,
  },
  {
    client: {
      schema: z.string().optional(),
      description: "The MCP client to register with (e.g., cursor, claude-desktop)",
      required: false,
    },
  }
) satisfies CommandParameterMap;

export function registerMcpRegisterCommand(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "mcp.register",
      category: CommandCategory.MCP,
      name: "register",
      description: "Register Minsky as an MCP server with a supported client",
      parameters: mcpRegisterParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          // 1. Resolve the repo path
          const repoPath = params.repo || params.workspacePath || process.cwd();

          // 2. Check that .minsky/config.yaml exists
          const configYamlPath = path.join(repoPath, ".minsky", "config.yaml");
          if (!existsSync(configYamlPath)) {
            // eslint-disable-next-line custom/no-validation-error-in-execute
            throw new ValidationError(
              "This project hasn't been initialized. Run `minsky init` first."
            );
          }

          // 3. Load the project config and read the `mcp` section
          const projectConfig = loadProjectConfiguration(repoPath);
          const mcpConfig: McpConfig = (projectConfig as Record<string, unknown>).mcp as McpConfig;
          const resolvedMcpConfig = mcpConfig ?? { transport: "stdio" as const };

          // 4. Determine the client to register with
          let client = params.client;

          if (!client) {
            const detectedClients = detectInstalledClients();

            if (detectedClients.length === 0) {
              // eslint-disable-next-line custom/no-validation-error-in-execute
              throw new ValidationError(
                "No supported MCP clients detected. Use --client to specify."
              );
            }

            if (detectedClients.length === 1) {
              const singleClient = detectedClients[0] as string;
              if (isInteractive()) {
                // Confirm with user in interactive mode
                const useDetected = await confirm({
                  message: `Detected MCP client: ${singleClient}. Register with it?`,
                  initialValue: true,
                });

                if (isCancel(useDetected)) {
                  cancel("Registration cancelled.");
                  return { success: false, message: "Registration cancelled by user." };
                }

                if (!useDetected) {
                  // eslint-disable-next-line custom/no-validation-error-in-execute
                  throw new ValidationError(
                    "No client selected. Use --client to specify a client."
                  );
                }
              }
              // In non-interactive mode, use the single detected client directly
              client = singleClient;
            } else {
              // Multiple clients found
              if (!isInteractive()) {
                // eslint-disable-next-line custom/no-validation-error-in-execute
                throw new ValidationError(
                  `Multiple MCP clients detected: ${detectedClients.join(", ")}. Use --client to specify one.`
                );
              }

              // Prompt user to select in interactive mode
              const selectedClient = await select({
                message: "Multiple MCP clients detected. Select one to register with:",
                options: detectedClients.map((c) => ({ value: c, label: c })),
              });

              if (isCancel(selectedClient)) {
                cancel("Registration cancelled.");
                return { success: false, message: "Registration cancelled by user." };
              }

              client = selectedClient as string;
            }
          }

          // 5. Register with the selected client
          const overwrite = params.overwrite ?? false;
          await registerWithClient(repoPath, resolvedMcpConfig, client, undefined, overwrite);

          // Determine the config file path for the success message
          const registrar = getRegistrar(client);
          const configFilePath = registrar.configPath(repoPath);

          return {
            success: true,
            message: `Registered Minsky as MCP server with ${client}.`,
            configFilePath,
            client,
          };
        } catch (error: unknown) {
          if (error instanceof ValidationError) {
            throw error;
          }
          // eslint-disable-next-line custom/no-validation-error-in-execute
          throw new ValidationError(getErrorMessage(error));
        }
      },
    })
  );
}
