/**
 * Config get, set, and unset commands
 */

import { z } from "zod";
import { CommandCategory, defineCommand } from "../../command-registry";
import { createConfigWriter } from "../../../../domain/configuration/config-writer";
import { getErrorMessage } from "../../../../errors/index";
import { composeParams } from "../../common-parameters";
import { configCommandParams } from "./list-show-commands";
import { parseConfigValue } from "./config-helpers";

/**
 * Config get command
 */
export const configGetRegistration = defineCommand({
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
      const { getConfigurationProvider } = await import("../../../../domain/configuration/index");
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
export const configSetRegistration = defineCommand({
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
export const configUnsetRegistration = defineCommand({
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
