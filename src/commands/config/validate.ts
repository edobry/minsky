/**
 * minsky config validate command
 *
 * Validates configuration against schemas and checks for issues
 */

import { Command } from "commander";
import { getConfigurationProvider, validateConfiguration } from "../../domain/configuration";
import { log } from "../../utils/logger";

interface ValidateOptions {
  json?: boolean;
  verbose?: boolean;
}

/**
 * Execute the config validate action - extracted for testability
 */
export async function executeConfigValidate(options: ValidateOptions): Promise<void> {
  try {
    // Get current configuration
    const provider = getConfigurationProvider();
    const config = provider.getConfig();

    // Validate configuration
    const validationResult = validateConfiguration();

    // Check for issues
    const hasErrors = validationResult.errors.some((error) => error.severity === "error");
    const hasWarnings = validationResult.errors.some((error) => error.severity === "warning");

    if (options.json) {
      log.debug(
        JSON.stringify(
          {
            valid: validationResult.valid,
            hasErrors,
            hasWarnings,
            errors: validationResult.errors,
            totalIssues: validationResult.errors.length,
          },
          null,
          2
        )
      );
    } else {
      if (validationResult.valid && validationResult.errors.length === 0) {
        log.debug("✅ Configuration is valid");
        if (options.verbose) {
          log.debug("   No issues found");
          log.debug(
            `   Configuration loaded from: ${provider
              .getMetadata()
              .sources.map((s) => s.path)
              .filter(Boolean)
              .join(", ")}`
          );
        }
      } else {
        if (hasErrors) {
          log.debug("❌ Configuration has errors");
        } else if (hasWarnings) {
          log.debug("⚠️  Configuration has warnings");
        }

        log.debug(`   Total issues: ${validationResult.errors.length}`);

        if (options.verbose || validationResult.errors.length <= 10) {
          log.debug("");
          for (const error of validationResult.errors) {
            const icon =
              error.severity === "error" ? "❌" : error.severity === "warning" ? "⚠️" : "ℹ️";
            log.debug(`${icon} ${error.path}: ${error.message}`);
          }
        } else {
          log.debug("   Use --verbose to see all issues");
        }
      }
    }

    // Exit with error code if there are validation errors
    if (hasErrors) {
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      log.debug(
        JSON.stringify(
          {
            valid: false,
            error: message,
          },
          null,
          2
        )
      );
    } else {
      log.error(`Failed to validate configuration: ${message}`);
    }

    process.exit(1);
  }
}

export function createConfigValidateCommand(): Command {
  return new Command("validate")
    .description("Validate configuration against schemas")
    .option("--json", "Output in JSON format", false)
    .option("--verbose", "Show detailed validation results", false)
    .addHelpText(
      "after",
      `
Examples:
  minsky config validate
  minsky config validate --verbose
  minsky config validate --json
`
    )
    .action(executeConfigValidate);
}
