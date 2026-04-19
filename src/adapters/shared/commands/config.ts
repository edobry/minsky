/**
 * Shared Config Commands
 *
 * This module contains shared config command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { createConfigWriter } from "../../../domain/configuration/config-writer";
import { DefaultCredentialResolver } from "../../../domain/configuration/credential-resolver";
import { log } from "../../../utils/logger";
import { CommonParameters, ConfigParameters, composeParams } from "../common-parameters";

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
 * Masks sensitive credential values in configuration
 * @param config Configuration object
 * @param showSecrets Whether to show actual secret values
 * @returns Configuration with credentials masked unless showSecrets is true
 */
function maskCredentials(
  config: Record<string, unknown>,
  showSecrets: boolean
): Record<string, unknown> {
  if (showSecrets) {
    return config;
  }

  const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>; // Deep clone

  // Mask AI provider API keys
  const maskedAi = masked.ai as Record<string, unknown> | undefined;
  if (maskedAi?.providers) {
    for (const [_provider, providerConfig] of Object.entries(
      maskedAi.providers as Record<string, unknown>
    )) {
      if (providerConfig && typeof providerConfig === "object") {
        const cfg = providerConfig as Record<string, unknown>;
        if (cfg.apiKey) {
          cfg.apiKey = `${"*".repeat(20)} (configured)`;
        }
      }
    }
  }

  // Mask GitHub token
  const maskedGithub = masked.github as Record<string, unknown> | undefined;
  if (maskedGithub?.token) {
    maskedGithub.token = `${"*".repeat(20)} (configured)`;
  }

  // Mask any other potential credential fields
  const maskedSessiondb = masked.sessiondb as Record<string, unknown> | undefined;
  if (maskedSessiondb?.connectionString) {
    maskedSessiondb.connectionString = `${"*".repeat(20)} (configured)`;
  }

  return masked;
}

function maskCredentialsInEffectiveValues(
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>,
  showSecrets: boolean
): Record<string, { value: unknown; source: string; path: string }> {
  if (showSecrets) {
    return effectiveValues;
  }

  const masked: Record<string, { value: unknown; source: string; path: string }> = {};

  // Helper to check if a path contains sensitive information
  const isSensitivePath = (path: string): boolean => {
    return (
      path.includes("token") ||
      path.includes("apiKey") ||
      path.includes("password") ||
      path.includes("secret") ||
      path.includes("key") ||
      path.includes("connectionString")
    );
  };

  // Helper to mask value (but don't re-mask already masked values)
  const maskValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      // If it's already masked, don't re-mask it
      if (value.includes("*") && value.includes("(configured)")) {
        return value;
      }
      return `${"*".repeat(20)} (configured)`;
    }
    return "[MASKED]";
  };

  for (const [path, valueInfo] of Object.entries(effectiveValues)) {
    if (isSensitivePath(path) && valueInfo.value !== null && valueInfo.value !== undefined) {
      masked[path] = {
        ...valueInfo,
        value: maskValue(valueInfo.value),
      };
    } else {
      masked[path] = valueInfo;
    }
  }

  return masked;
}

/**
 * Config list command definition
 */
const configListRegistration = defineCommand({
  id: "config.list",
  category: CommandCategory.CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  parameters: configListParams,
  execute: async (params, _ctx) => {
    try {
      // Use custom configuration system to get configuration
      const { getConfigurationProvider } = await import("../../../domain/configuration/index");
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
const configShowRegistration = defineCommand({
  id: "config.show",
  category: CommandCategory.CONFIG,
  name: "show",
  description: "Show the final resolved configuration",
  parameters: configShowParams,
  execute: async (params, _ctx) => {
    try {
      // Use custom configuration system to get resolved configuration
      const { getConfigurationProvider } = await import("../../../domain/configuration/index");
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

/**
 * Safely gather credential information for display
 */
async function gatherCredentialInfo(
  credentialResolver: DefaultCredentialResolver,
  config: Record<string, unknown>,
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>
) {
  const credentials: Record<string, unknown> = {};

  // Check GitHub credentials
  try {
    const githubToken = await credentialResolver.getCredential("github");
    if (githubToken) {
      credentials.github = {
        token: `${"*".repeat(20)} (configured)`,
        source: effectiveValues["github.token"]?.source ?? "unknown",
      };
    }
  } catch (error) {
    // Ignore credential resolution errors for display
  }

  // Check AI provider credentials
  const configAi = config.ai as Record<string, unknown> | undefined;
  if (configAi?.providers) {
    credentials.ai = {};
    for (const [provider, providerConfig] of Object.entries(
      configAi.providers as Record<string, unknown>
    )) {
      if (
        provider &&
        provider !== "undefined" &&
        providerConfig &&
        typeof providerConfig === "object"
      ) {
        const providerCfg = providerConfig as Record<string, unknown>;
        if (providerCfg.apiKey) {
          const keyPath = `ai.providers.${provider}.apiKey`;
          (credentials.ai as Record<string, unknown>)[provider] = {
            apiKey: `${"*".repeat(20)} (configured)`,
            source: effectiveValues[keyPath]?.source ?? "unknown",
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
  sharedCommandRegistry.registerCommand(configGetRegistration);
  sharedCommandRegistry.registerCommand(configSetRegistration);
  sharedCommandRegistry.registerCommand(configUnsetRegistration);
  sharedCommandRegistry.registerCommand(configValidateRegistration);
  sharedCommandRegistry.registerCommand(configDoctorRegistration);
}

/**
 * Helper: parse configuration value from string input
 */
function parseConfigValue(value: string): unknown {
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
 * Config get command
 */
const configGetRegistration = defineCommand({
  id: "config.get",
  category: CommandCategory.CONFIG,
  name: "get",
  description: "Get a configuration value by key path",
  parameters: composeParams(configCommandParams, {
    key: {
      schema: z.string(),
      description: "Configuration key path",
      required: true as const,
    },
  }),
  execute: async (params, _ctx) => {
    try {
      const { getConfigurationProvider } = await import("../../../domain/configuration/index");
      const provider = getConfigurationProvider();

      const exists = provider.has(params.key);
      if (!exists) {
        return {
          success: false,
          json: params.json || false,
          error: `Configuration path '${params.key}' not found`,
          key: params.key,
          exists: false,
        };
      }

      // Will throw if not found, but we've already checked with has()
      const value = provider.get(params.key);
      return {
        success: true,
        json: params.json || false,
        key: params.key,
        value,
        exists: true,
      };
    } catch (error) {
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error),
        key: params.key,
      };
    }
  },
});

/**
 * Config set command
 */
const configSetRegistration = defineCommand({
  id: "config.set",
  category: CommandCategory.CONFIG,
  name: "set",
  description: "Set a configuration value",
  parameters: composeParams(configCommandParams, {
    key: {
      schema: z.string(),
      description: "Configuration key path",
      required: true as const,
    },
    value: { schema: z.string(), description: "Value to set", required: true as const },
    noBackup: {
      schema: z.boolean(),
      description: "Skip creating backup before modification",
      required: false as const,
      defaultValue: false,
    },
    format: {
      schema: z.enum(["yaml", "json"]).default("yaml"),
      description: "File format to use",
      required: false as const,
      defaultValue: "yaml",
    },
  }),
  execute: async (params, _ctx) => {
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
});

/**
 * Config unset command
 */
const configUnsetRegistration = defineCommand({
  id: "config.unset",
  category: CommandCategory.CONFIG,
  name: "unset",
  description: "Remove a configuration value",
  parameters: composeParams(configCommandParams, {
    key: {
      schema: z.string(),
      description: "Configuration key path",
      required: true as const,
    },
    noBackup: {
      schema: z.boolean(),
      description: "Skip creating backup before modification",
      required: false as const,
      defaultValue: false,
    },
    format: {
      schema: z.enum(["yaml", "json"]).default("yaml"),
      description: "File format to use",
      required: false as const,
      defaultValue: "yaml",
    },
  }),
  execute: async (params, _ctx) => {
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
});

/**
 * Config validate command
 */
const configValidateRegistration = defineCommand({
  id: "config.validate",
  category: CommandCategory.CONFIG,
  name: "validate",
  description: "Validate configuration against schemas",
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed validation results",
      required: false as const,
      defaultValue: false,
    },
  }),
  execute: async (params, _ctx) => {
    const { getConfigurationProvider, validateConfiguration } = await import(
      "../../../domain/configuration/index"
    );
    const provider = getConfigurationProvider();
    const validationResult = validateConfiguration();
    const hasErrors = validationResult.errors.some(
      (e: { severity?: string }) => e.severity === "error"
    );
    const hasWarnings = validationResult.errors.some(
      (e: { severity?: string }) => e.severity === "warning"
    );

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
});

/**
 * Config doctor command
 */
const configDoctorRegistration = defineCommand({
  id: "config.doctor",
  category: CommandCategory.CONFIG,
  name: "doctor",
  description: "Diagnose common configuration problems",
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed diagnostic results",
      required: false as const,
      defaultValue: false,
    },
  }),
  execute: async (params, ctx) => {
    // Perform lightweight diagnostics without external calls
    const diagnostics: Array<{ check: string; status: string; message: string }> = [];
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
        message: `Configuration loading failed: ${getErrorMessage(e)}`,
      });
    }

    try {
      const validationResult = validateConfiguration();
      const hasErrors = validationResult.errors.some(
        (e: { severity?: string }) => e.severity === "error"
      );
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
        message: `Validation check failed: ${getErrorMessage(e)}`,
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
        message: `Filesystem check failed: ${getErrorMessage(e)}`,
      });
    }

    // Embedding provider health probe
    try {
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const embProvider = config.embeddings?.provider || config.ai?.defaultProvider || "openai";
      const embModel = config.embeddings?.model || "text-embedding-3-small";
      const providerCfg = config.ai?.providers?.[embProvider];
      const hasKey = Boolean(providerCfg?.apiKey || providerCfg?.api_key);

      if (!hasKey) {
        diagnostics.push({
          check: "Embedding Provider",
          status: "warning",
          message: `Embedding provider "${embProvider}" has no API key configured`,
        });
      } else {
        const { createEmbeddingServiceFromConfig } = await import(
          "../../../domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();
        await embeddingService.generateEmbedding("test");
        diagnostics.push({
          check: "Embedding Provider",
          status: "pass",
          message: `Embedding provider "${embProvider}" (${embModel}) is working`,
        });
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      const isQuota = /quota|429|insufficient/i.test(msg);
      const isAuth = /401|unauthorized|api.key/i.test(msg);
      diagnostics.push({
        check: "Embedding Provider",
        status: "error",
        message: `Embedding provider check failed: ${msg}`,
        ...(isQuota && {
          suggestion: "Check your OpenAI billing at https://platform.openai.com/account/billing",
        }),
        ...(isAuth && {
          suggestion: "API key may be invalid or expired — https://platform.openai.com/api-keys",
        }),
      });
    }

    // Embedding index coverage
    try {
      const provider = ctx.container?.has("persistence")
        ? (ctx.container.get(
            "persistence"
          ) as import("../../../domain/persistence/types").PersistenceProvider)
        : null;
      if (provider) {
        if (provider.capabilities.sql) {
          const rawSql = await provider.getRawSqlConnection?.();
          if (rawSql) {
            const sql = rawSql as import("postgres").Sql;
            const [taskCount] = await sql.unsafe("SELECT count(*) as count FROM tasks");
            const [embCount] = await sql.unsafe("SELECT count(*) as count FROM tasks_embeddings");
            const [lastIdx] = await sql.unsafe(
              "SELECT max(indexed_at) as last_indexed FROM tasks_embeddings"
            );
            const total = Number(taskCount?.count ?? 0);
            const indexed = Number(embCount?.count ?? 0);
            const lastIndexed = lastIdx?.last_indexed
              ? new Date(lastIdx.last_indexed as string).toISOString()
              : "never";
            const pct = total > 0 ? Math.round((indexed / total) * 100) : 0;
            diagnostics.push({
              check: "Embedding Index Coverage",
              status: pct >= 90 ? "pass" : pct >= 50 ? "warning" : "error",
              message: `${indexed}/${total} tasks indexed (${pct}%), last indexed: ${lastIndexed}`,
              ...(pct < 90 && {
                suggestion: "Run 'minsky tasks index-embeddings' to index missing tasks",
              }),
            });
          }
        }
      }
    } catch {
      // Index coverage is best-effort — skip if DB not available
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
});
