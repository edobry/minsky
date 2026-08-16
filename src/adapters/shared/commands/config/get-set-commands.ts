/**
 * Config Get, Set, and Unset Commands
 *
 * Defines the config.get, config.set, and config.unset command registrations.
 */

import { z } from "zod";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { CommandCategory, defineCommand } from "../../command-registry";
import { createConfigWriter } from "@minsky/domain/configuration/config-writer";
import { CommonParameters, ConfigParameters, composeParams } from "../../common-parameters";
import { parseConfigValue, maskValueForPath } from "./helpers";

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
 * Config get command
 */
export const configGetRegistration = defineCommand({
  id: "config.get",
  category: CommandCategory.CONFIG,
  name: "get",
  description: "Get a configuration value by key path",
  requiresSetup: false,
  parameters: composeParams(configCommandParams, {
    key: {
      schema: z.string(),
      description: "Configuration key path",
      required: true as const,
    },
    // mt#3634: mirrors config.list / config.show. Without this, `config get
    // github.token` returned the credential VERBATIM — no masking, no flag
    // required. Found by extending the sibling-surface audit from a static
    // read to an actual end-to-end run.
    showSecrets: {
      schema: z.boolean(),
      description: "Show actual credential values (SECURITY RISK: use with caution)",
      required: false as const,
      defaultValue: false,
    },
  }),
  execute: async (params, _ctx) => {
    try {
      const { getConfigurationProvider } = await import("@minsky/domain/configuration/index");
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
        // mt#3634: masked by default, on the SAME rules the other config
        // surfaces use — a sensitive key path masks the value, and a composite
        // value under a non-sensitive path still gets traversed for nested
        // credentials.
        value: params.showSecrets ? value : maskValueForPath(params.key, value),
        exists: true,
        credentialsMasked: !params.showSecrets,
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
export const configSetRegistration = defineCommand({
  id: "config.set",
  category: CommandCategory.CONFIG,
  name: "set",
  description: "Set a configuration value",
  requiresSetup: false,
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
      // mt#2702: the write echo is masked on the SAME rules config.get uses.
      // Masking binds here, on the payload, rather than in the CLI renderer:
      // per ADR-039 a command's result is render-by-default, so a credential
      // left in the payload reaches stdout through the registered formatter,
      // through the --json branch (which stringifies this object whole), and
      // through every MCP caller — the last of which persists it verbatim to
      // agent_transcripts. There is deliberately no showSecrets escape here:
      // the caller just supplied this value, so echoing it back is worth
      // nothing to them and costs a durable copy.
      previousValue: maskValueForPath(params.key, result.previousValue),
      newValue: maskValueForPath(params.key, result.newValue),
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  },
});

/**
 * Config unset command
 */
export const configUnsetRegistration = defineCommand({
  id: "config.unset",
  category: CommandCategory.CONFIG,
  name: "unset",
  description: "Remove a configuration value",
  requiresSetup: false,
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
      // mt#2702: same masking as config.set above. Unset echoes the value
      // being REMOVED, so on a credential key the secret is exactly what the
      // confirmation would carry.
      previousValue: maskValueForPath(params.key, result.previousValue),
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  },
});
