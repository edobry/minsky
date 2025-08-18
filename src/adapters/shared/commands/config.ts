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
import { createConfigWriter } from "../../../domain/configuration/config-writer";
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
  sharedCommandRegistry.registerCommand(configSetRegistration);
  sharedCommandRegistry.registerCommand(configUnsetRegistration);
  sharedCommandRegistry.registerCommand(configValidateRegistration);
  sharedCommandRegistry.registerCommand(configDoctorRegistration);
}

/**
 * Helper: parse configuration value from string input
 */
function parseConfigValue(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined") return undefined;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }

  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }

  return value;
}

/**
 * Config set command
 */
const configSetRegistration = {
  id: "config.set",
  category: CommandCategory.CONFIG,
  name: "set",
  description: "Set a configuration value",
  parameters: composeParams(configCommandParams, {
    key: { schema: z.string(), description: "Configuration key path", required: true },
    value: { schema: z.string(), description: "Value to set", required: true },
    noBackup: {
      schema: z.boolean(),
      description: "Skip creating backup before modification",
      required: false,
      defaultValue: false,
    },
    format: {
      schema: z.enum(["yaml", "json"]).default("yaml"),
      description: "File format to use",
      required: false,
      defaultValue: "yaml",
    },
  }),
  execute: async (params: any) => {
    const writer = createConfigWriter({
      createBackup: !params.noBackup,
      format: params.format === "json" ? "json" : "yaml",
      validate: true,
    });

    const parsed = parseConfigValue(params.value);
    const result = await writer.setConfigValue(params.key, parsed);

    if (!result.success) {
      return {
        success: false,
        json: params.json || false,
        error: `Failed to set configuration: ${result.error}`,
      };
    }

    return {
      success: true,
      json: params.json || false,
      key: params.key,
      previousValue: result.previousValue,
      newValue: result.newValue,
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  },
} as any;

/**
 * Config unset command
 */
const configUnsetRegistration = {
  id: "config.unset",
  category: CommandCategory.CONFIG,
  name: "unset",
  description: "Remove a configuration value",
  parameters: composeParams(configCommandParams, {
    key: { schema: z.string(), description: "Configuration key path", required: true },
    noBackup: {
      schema: z.boolean(),
      description: "Skip creating backup before modification",
      required: false,
      defaultValue: false,
    },
    format: {
      schema: z.enum(["yaml", "json"]).default("yaml"),
      description: "File format to use",
      required: false,
      defaultValue: "yaml",
    },
  }),
  execute: async (params: any) => {
    const writer = createConfigWriter({
      createBackup: !params.noBackup,
      format: params.format === "json" ? "json" : "yaml",
      validate: true,
    });

    const result = await writer.unsetConfigValue(params.key);

    if (!result.success) {
      return {
        success: false,
        json: params.json || false,
        error: `Failed to unset configuration: ${result.error}`,
      };
    }

    return {
      success: true,
      json: params.json || false,
      key: params.key,
      previousValue: result.previousValue,
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  },
} as any;

/**
 * Config validate command
 */
const configValidateRegistration = {
  id: "config.validate",
  category: CommandCategory.CONFIG,
  name: "validate",
  description: "Validate configuration against schemas",
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed validation results",
      required: false,
      defaultValue: false,
    },
  }),
  execute: async (params: any) => {
    const { getConfigurationProvider, validateConfiguration } = await import(
      "../../../domain/configuration/index"
    );
    const provider = getConfigurationProvider();
    const validationResult = validateConfiguration();
    const hasErrors = validationResult.errors.some((e: any) => e.severity === "error");
    const hasWarnings = validationResult.errors.some((e: any) => e.severity === "warning");

    return {
      success: validationResult.valid && !hasErrors,
      json: params.json || false,
      valid: validationResult.valid,
      hasErrors,
      hasWarnings,
      errors: validationResult.errors,
      totalIssues: validationResult.errors.length,
      sources: provider.getMetadata?.().sources,
      verbose: params.verbose || false,
    };
  },
} as any;

/**
 * Config doctor command
 */
const configDoctorRegistration = {
  id: "config.doctor",
  category: CommandCategory.CONFIG,
  name: "doctor",
  description: "Diagnose common configuration problems",
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed diagnostic results",
      required: false,
      defaultValue: false,
    },
  }),
  execute: async (params: any) => {
    // Perform lightweight diagnostics without external calls
    const diagnostics: any[] = [];
    const { getConfigurationProvider, validateConfiguration } = await import(
      "../../../domain/configuration/index"
    );
    const { getUserConfigDir } = await import("../../../domain/configuration/sources/user");
    const { existsSync, writeFileSync, unlinkSync } = await import("fs");
    const { join } = await import("path");

    try {
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      if (config) {
        diagnostics.push({
          check: "Configuration Loading",
          status: "pass",
          message: "Configuration loaded successfully",
        });
      } else {
        diagnostics.push({
          check: "Configuration Loading",
          status: "error",
          message: "Configuration could not be loaded",
        });
      }
    } catch (e) {
      diagnostics.push({
        check: "Configuration Loading",
        status: "error",
        message: `Configuration loading failed: ${getErrorMessage(e as any)}`,
      });
    }

    try {
      const validationResult = validateConfiguration();
      const hasErrors = validationResult.errors.some((e: any) => e.severity === "error");
      diagnostics.push({
        check: "Configuration Validation",
        status: hasErrors ? "error" : validationResult.errors.length > 0 ? "warning" : "pass",
        message:
          validationResult.errors.length === 0
            ? "Configuration passes validation"
            : `Found ${validationResult.errors.length} validation issues`,
      });
    } catch (e) {
      diagnostics.push({
        check: "Configuration Validation",
        status: "error",
        message: `Validation check failed: ${getErrorMessage(e as any)}`,
      });
    }

    try {
      const configDir = getUserConfigDir();
      if (!existsSync(configDir)) {
        diagnostics.push({
          check: "Configuration Directory",
          status: "warning",
          message: `Configuration directory does not exist: ${configDir}`,
        });
      } else {
        diagnostics.push({
          check: "Configuration Directory",
          status: "pass",
          message: `Configuration directory exists: ${configDir}`,
        });

        // Basic write test
        const testFile = join(configDir, ".minsky-test");
        try {
          writeFileSync(testFile, "test");
          unlinkSync(testFile);
          diagnostics.push({
            check: "File Permissions",
            status: "pass",
            message: "Configuration directory is writable",
          });
        } catch {
          diagnostics.push({
            check: "File Permissions",
            status: "error",
            message: "Configuration directory is not writable",
          });
        }
      }
    } catch (e) {
      diagnostics.push({
        check: "Filesystem Check",
        status: "error",
        message: `Filesystem check failed: ${getErrorMessage(e as any)}`,
      });
    }

    const errors = diagnostics.filter((d) => d.status === "error");
    const warnings = diagnostics.filter((d) => d.status === "warning");

    return {
      success: errors.length === 0,
      json: params.json || false,
      summary: {
        total: diagnostics.length,
        passed: diagnostics.filter((d) => d.status === "pass").length,
        warnings: warnings.length,
        errors: errors.length,
      },
      diagnostics,
      healthy: errors.length === 0,
      verbose: params.verbose || false,
    };
  },
} as any;
