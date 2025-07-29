/**
 * Shared Config Commands
 *
 * This module contains shared config command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { has, get, getConfiguration } from "../../../domain/configuration/index";
import { DefaultCredentialResolver } from "../../../domain/configuration/credential-resolver";
import { log } from "../../../utils/logger";
import { CommonParameters, ConfigParameters, composeParams } from "../common-parameters";

/**
 * Shared parameters for config commands (eliminates duplication)
 */
const configCommandParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    workspace: CommonParameters.workspace,
    json: CommonParameters.json,
  },
  {
    sources: ConfigParameters.sources,
  }
);

/**
 * Parameters for config list command
 */
const configListParams: CommandParameterMap = composeParams(configCommandParams, {
  showSecrets: {
    schema: z.boolean(),
    description: "Show actual credential values (SECURITY RISK: use with caution)",
    required: false,
    defaultValue: false,
  },
});

/**
 * Parameters for config show command
 */
const configShowParams: CommandParameterMap = configCommandParams;

/**
 * Masks sensitive credential values in configuration
 * @param config Configuration object
 * @param showSecrets Whether to show actual secret values
 * @returns Configuration with credentials masked unless showSecrets is true
 */
function maskCredentials(config: any, showSecrets: boolean): any {
  if (showSecrets) {
    return config;
  }

  const masked = JSON.parse(JSON.stringify(config)); // Deep clone

  // Mask AI provider API keys
  if (masked.ai?.providers) {
    for (const [provider, providerConfig] of Object.entries(masked.ai.providers)) {
      if (providerConfig && typeof providerConfig === "object") {
        const cfg = providerConfig as any;
        if (cfg.apiKey) {
          cfg.apiKey = `${"*".repeat(20)} (configured)`;
        }
      }
    }
  }

  // Mask GitHub token
  if (masked.github?.token) {
    masked.github.token = `${"*".repeat(20)} (configured)`;
  }

  // Mask any other potential credential fields
  if (masked.sessiondb?.connectionString) {
    masked.sessiondb.connectionString = `${"*".repeat(20)} (configured)`;
  }

  return masked;
}

/**
 * Config list command definition
 */
const configListRegistration = {
  id: "config.list",
  category: CommandCategory.CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  parameters: configListParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use custom configuration system to get configuration
      const { getConfigurationProvider } = await import("../../../domain/configuration/index");
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const metadata = provider.getMetadata();

      const resolved = {
        backend: config.backend,
        backendConfig: config.backendConfig,
        sessiondb: config.sessiondb,
        ai: config.ai,
        github: config.github,
      };

      // Apply credential masking unless explicitly requested to show secrets
      const maskedConfig = maskCredentials(resolved, params.showSecrets || false);

      return {
        success: true,
        json: params.json || false,
        sources: metadata.sources.map((source) => ({
          name: source.name,
          priority: source.priority,
          loaded: source.loaded,
          path: source.path,
          error: source.error,
        })),
        resolved: maskedConfig,
        showSources: params.sources || false,
        credentialsMasked: !params.showSecrets,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error as any),
        showSources: (params as any).sources || false,
      };
    }
  },
} as any;

/**
 * Config show command definition
 */
const configShowRegistration = {
  id: "config.show",
  category: CommandCategory.CONFIG,
  name: "show",
  description: "Show the final resolved configuration",
  parameters: configShowParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use custom configuration system to get resolved configuration
      const config = getConfiguration();

      // Gather credential information safely
      const credentialResolver = new DefaultCredentialResolver();
      const credentials = await gatherCredentialInfo(credentialResolver, config);

      const resolved = {
        backend: config.backend,
        backendConfig: config.backendConfig,
        sessiondb: config.sessiondb,
        ai: config.ai,
        github: config.github,
        logger: config.logger,
        credentials,
      };

      return {
        success: true,
        json: params.json || false,
        configuration: resolved,
        showSources: params.sources || false,
        ...(params.sources && {
          sources: [
            { name: "custom-config", original: "Custom Configuration System", parsed: resolved },
          ],
        }),
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error as any),
        showSources: (params as any).sources || false,
      };
    }
  },
} as any;

/**
 * Safely gather credential information for display
 */
async function gatherCredentialInfo(credentialResolver: DefaultCredentialResolver, config: any) {
  const credentials: any = {};

  // Check GitHub credentials
  try {
    const githubToken = await credentialResolver.getCredential("github");
    if (githubToken) {
      credentials.github = {
        token: `${"*".repeat(20)} (configured)`,
        source: "environment", // Simplified for display
      };
    }
  } catch (error) {
    // Ignore credential resolution errors for display
  }

  // Check AI provider credentials
  if (config.ai?.providers) {
    credentials.ai = {};
    for (const [provider, providerConfig] of Object.entries(config.ai.providers)) {
      if (
        provider &&
        provider !== "undefined" &&
        providerConfig &&
        typeof providerConfig === "object"
      ) {
        const providerCfg = providerConfig as any;
        if (providerCfg.apiKey) {
          credentials.ai[provider] = {
            apiKey: `${"*".repeat(20)} (configured)`,
            source: "environment",
          };
        }
      }
    }
  }

  return credentials;
}

/**
 * Register all config commands
 */
export function registerConfigCommands() {
  sharedCommandRegistry.registerCommand(configListRegistration);
  sharedCommandRegistry.registerCommand(configShowRegistration);
}
