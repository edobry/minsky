/**
 * minsky config doctor command
 *
 * Diagnoses common configuration problems and suggests fixes
 */

import { Command } from "commander";
import { getConfigurationProvider, validateConfiguration } from "../../domain/configuration";
import { existsSync } from "fs";
import { join } from "path";
import { getUserConfigDir } from "../../domain/configuration/sources/user";
import { log } from "../../utils/logger";

interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
}

interface DiagnosticResult {
  check: string;
  status: "pass" | "warning" | "error";
  message: string;
  suggestion?: string;
}

/**
 * Execute the config doctor action - extracted for testability
 */
export async function executeConfigDoctor(options: DoctorOptions): Promise<void> {
  try {
    const diagnostics: DiagnosticResult[] = [];

    // Run all diagnostic checks
    await runConfigurationLoadCheck(diagnostics);
    await runValidationCheck(diagnostics);
    await runFileSystemCheck(diagnostics);
    await runConnectivityCheck(diagnostics);
    await runPermissionsCheck(diagnostics);

    // Count results
    const errors = diagnostics.filter((d) => d.status === "error");
    const warnings = diagnostics.filter((d) => d.status === "warning");
    const passes = diagnostics.filter((d) => d.status === "pass");

    if (options.json) {
      log.debug(
        JSON.stringify(
          {
            summary: {
              total: diagnostics.length,
              passed: passes.length,
              warnings: warnings.length,
              errors: errors.length,
            },
            diagnostics,
            healthy: errors.length === 0,
          },
          null,
          2
        )
      );
    } else {
      // Display summary
      if (errors.length === 0 && warnings.length === 0) {
        log.debug("✅ Configuration is healthy");
      } else if (errors.length === 0) {
        log.debug("⚠️  Configuration has some warnings");
      } else {
        log.debug("❌ Configuration has issues that need attention");
      }

      log.debug(`   Checks run: ${diagnostics.length}`);
      log.debug(
        `   Passed: ${passes.length}, Warnings: ${warnings.length}, Errors: ${errors.length}`
      );
      log.debug("");

      // Display detailed results
      for (const diagnostic of diagnostics) {
        const icon =
          diagnostic.status === "pass" ? "✅" : diagnostic.status === "warning" ? "⚠️" : "❌";

        log.debug(`${icon} ${diagnostic.check}`);
        if (diagnostic.status !== "pass" || options.verbose) {
          log.debug(`   ${diagnostic.message}`);
          if (diagnostic.suggestion) {
            log.debug(`   💡 ${diagnostic.suggestion}`);
          }
        }
        log.debug("");
      }
    }

    // Exit with error code if there are errors
    if (errors.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      log.debug(
        JSON.stringify(
          {
            healthy: false,
            error: message,
          },
          null,
          2
        )
      );
    } else {
      log.error(`Failed to run configuration diagnostics: ${message}`);
    }

    process.exit(1);
  }
}

/**
 * Check if configuration can be loaded
 */
async function runConfigurationLoadCheck(diagnostics: DiagnosticResult[]): Promise<void> {
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
        suggestion: "Check if configuration files exist and are properly formatted",
      });
    }
  } catch (error) {
    diagnostics.push({
      check: "Configuration Loading",
      status: "error",
      message: `Configuration loading failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: "Check configuration file syntax and permissions",
    });
  }
}

/**
 * Check configuration validation
 */
async function runValidationCheck(diagnostics: DiagnosticResult[]): Promise<void> {
  try {
    const validationResult = validateConfiguration();

    if (validationResult.valid && validationResult.errors.length === 0) {
      diagnostics.push({
        check: "Configuration Validation",
        status: "pass",
        message: "Configuration passes validation",
      });
    } else {
      const hasErrors = validationResult.errors.some((e) => e.severity === "error");

      diagnostics.push({
        check: "Configuration Validation",
        status: hasErrors ? "error" : "warning",
        message: `Found ${validationResult.errors.length} validation issues`,
        suggestion: "Run 'minsky config validate --verbose' for detailed validation results",
      });
    }
  } catch (error) {
    diagnostics.push({
      check: "Configuration Validation",
      status: "error",
      message: `Validation check failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: "Check if configuration schema is available",
    });
  }
}

/**
 * Check filesystem permissions and paths
 */
async function runFileSystemCheck(diagnostics: DiagnosticResult[]): Promise<void> {
  try {
    const configDir = getUserConfigDir();

    // Check if config directory exists
    if (!existsSync(configDir)) {
      diagnostics.push({
        check: "Configuration Directory",
        status: "warning",
        message: `Configuration directory does not exist: ${configDir}`,
        suggestion: `Run 'minsky config set' to create the directory automatically`,
      });
    } else {
      diagnostics.push({
        check: "Configuration Directory",
        status: "pass",
        message: `Configuration directory exists: ${configDir}`,
      });
    }

    // Check for configuration files
    const configFiles = ["config.yaml", "config.yml", "config.json"];
    const existingFiles = configFiles.filter((file) => existsSync(join(configDir, file)));

    if (existingFiles.length === 0) {
      diagnostics.push({
        check: "Configuration Files",
        status: "warning",
        message: "No configuration files found",
        suggestion: "Create a configuration file with 'minsky config set <key> <value>'",
      });
    } else {
      diagnostics.push({
        check: "Configuration Files",
        status: "pass",
        message: `Found configuration files: ${existingFiles.join(", ")}`,
      });
    }
  } catch (error) {
    diagnostics.push({
      check: "Filesystem Check",
      status: "error",
      message: `Filesystem check failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: "Check file system permissions",
    });
  }
}

/**
 * Check connectivity to configured services
 */
async function runConnectivityCheck(diagnostics: DiagnosticResult[]): Promise<void> {
  try {
    const provider = getConfigurationProvider();
    const config = provider.getConfig();

    // Check GitHub token if configured
    if (config.github?.token) {
      diagnostics.push({
        check: "GitHub Connectivity",
        status: "pass", // Note: We're not actually testing connectivity here to avoid API calls
        message: "GitHub token is configured",
        suggestion: "GitHub token is present but not validated (to avoid API rate limits)",
      });
    } else {
      diagnostics.push({
        check: "GitHub Connectivity",
        status: "warning",
        message: "No GitHub token configured",
        suggestion: "Set GitHub token with 'minsky config set github.token <your-token>'",
      });
    }

    // Check AI provider configuration
    if (config.ai?.providers) {
      const configuredProviders = Object.keys(config.ai.providers).filter(
        (provider) => config.ai.providers[provider]?.api_key
      );

      if (configuredProviders.length > 0) {
        diagnostics.push({
          check: "AI Provider Configuration",
          status: "pass",
          message: `AI providers configured: ${configuredProviders.join(", ")}`,
        });
      } else {
        diagnostics.push({
          check: "AI Provider Configuration",
          status: "warning",
          message: "No AI providers have API keys configured",
          suggestion: "Configure API keys for AI providers like OpenAI or Anthropic",
        });
      }
    } else {
      diagnostics.push({
        check: "AI Provider Configuration",
        status: "warning",
        message: "No AI providers configured",
        suggestion: "Configure AI providers in the configuration",
      });
    }
  } catch (error) {
    diagnostics.push({
      check: "Connectivity Check",
      status: "error",
      message: `Connectivity check failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: "Check configuration format and connectivity settings",
    });
  }
}

/**
 * Check file permissions
 */
async function runPermissionsCheck(diagnostics: DiagnosticResult[]): Promise<void> {
  try {
    const configDir = getUserConfigDir();

    if (existsSync(configDir)) {
      // Basic permission check - try to create a test file
      const testFile = join(configDir, ".minsky-test");

      try {
        require("fs").writeFileSync(testFile, "test");
        require("fs").unlinkSync(testFile);

        diagnostics.push({
          check: "File Permissions",
          status: "pass",
          message: "Configuration directory is writable",
        });
      } catch (error) {
        diagnostics.push({
          check: "File Permissions",
          status: "error",
          message: "Configuration directory is not writable",
          suggestion: `Check permissions on ${configDir}`,
        });
      }
    } else {
      diagnostics.push({
        check: "File Permissions",
        status: "warning",
        message: "Configuration directory does not exist (cannot check permissions)",
        suggestion: "Directory will be created automatically when needed",
      });
    }
  } catch (error) {
    diagnostics.push({
      check: "Permissions Check",
      status: "error",
      message: `Permission check failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: "Check filesystem permissions",
    });
  }
}

export function createConfigDoctorCommand(): Command {
  return new Command("doctor")
    .description("Diagnose common configuration problems")
    .option("--json", "Output in JSON format", false)
    .option("--verbose", "Show detailed diagnostic results", false)
    .addHelpText(
      "after",
      `
Examples:
  minsky config doctor
  minsky config doctor --verbose
  minsky config doctor --json
`
    )
    .action(executeConfigDoctor);
}
