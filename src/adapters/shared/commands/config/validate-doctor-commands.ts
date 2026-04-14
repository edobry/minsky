/**
 * Config validate and doctor commands
 */

import { z } from "zod";
import { CommandCategory, defineCommand } from "../../command-registry";
import { getErrorMessage } from "../../../../errors/index";
import { composeParams } from "../../common-parameters";
import { configCommandParams } from "./shared";

/**
 * Config validate command
 */
export const configValidateRegistration = defineCommand({
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
      "../../../../domain/configuration/index"
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
export const configDoctorRegistration = defineCommand({
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
  execute: async (params, _ctx) => {
    // Perform lightweight diagnostics without external calls
    const diagnostics: Array<{ check: string; status: string; message: string }> = [];
    const { getConfigurationProvider, validateConfiguration } = await import(
      "../../../../domain/configuration/index"
    );
    const { getUserConfigDir } = await import("../../../../domain/configuration/sources/user");
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
