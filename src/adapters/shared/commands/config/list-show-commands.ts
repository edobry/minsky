/**
 * Config List and Show Commands
 *
 * Defines the config.list and config.show command registrations.
 */

import { z } from "zod";
import { getErrorMessage } from "../../../../errors/index";
import { CommandCategory, defineCommand } from "../../command-registry";
import { DefaultCredentialResolver } from "../../../../domain/configuration/credential-resolver";
import { log } from "../../../../utils/logger";
import { CommonParameters, ConfigParameters, composeParams } from "../../common-parameters";
import { maskCredentials, maskCredentialsInEffectiveValues, gatherCredentialInfo } from "./helpers";

/**
 * Shared parameters for config commands (eliminates duplication)
 */
const configCommandParams = composeParams(
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
const configListParams = composeParams(configCommandParams, {
  showSecrets: {
    schema: z.boolean(),
    description: "Show actual credential values (SECURITY RISK: use with caution)",
    required: false as const,
    defaultValue: false,
  },
});

/**
 * Parameters for config show command
 */
const configShowParams = configCommandParams;

/**
 * Config list command definition
 */
export const configListRegistration = defineCommand({
  id: "config.list",
  category: CommandCategory.CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  requiresSetup: false,
  parameters: configListParams,
  execute: async (params, _ctx) => {
    try {
      // Use custom configuration system to get configuration
      const { getConfigurationProvider } = await import("../../../../domain/configuration/index");
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const metadata = provider.getMetadata();
      const effectiveValues = provider.getEffectiveValues();

      // Show ALL configuration properties except deprecated ones
      const { backend: _deprecatedBackend, ...resolved } = config;

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
        effectiveValues: maskCredentialsInEffectiveValues(
          effectiveValues,
          params.showSecrets || false
        ),
        showSources: params.sources || false,
        credentialsMasked: !params.showSecrets,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error),
        showSources: params.sources || false,
      };
    }
  },
});

/**
 * Config show command definition
 */
export const configShowRegistration = defineCommand({
  id: "config.show",
  category: CommandCategory.CONFIG,
  name: "show",
  description: "Show the final resolved configuration",
  requiresSetup: false,
  parameters: configShowParams,
  execute: async (params, _ctx) => {
    try {
      // Use custom configuration system to get resolved configuration
      const { getConfigurationProvider } = await import("../../../../domain/configuration/index");
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const metadata = provider.getMetadata();
      const effectiveValues = provider.getEffectiveValues();

      // Gather credential information safely
      const credentialResolver = new DefaultCredentialResolver();
      const credentials = await gatherCredentialInfo(credentialResolver, config, effectiveValues);

      // Show ALL configuration properties dynamically instead of hardcoding subset
      const resolved = {
        ...config, // Include all configuration properties
        credentials,
      };

      return {
        success: true,
        json: params.json || false,
        configuration: resolved,
        showSources: params.sources || false,
        sources: metadata.sources.map((source) => ({
          name: source.name,
          priority: source.priority,
          loaded: source.loaded,
          path: source.path,
          error: source.error,
        })),
        effectiveValues: maskCredentialsInEffectiveValues(effectiveValues, false),
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error),
        showSources: params.sources || false,
      };
    }
  },
});
