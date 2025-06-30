/**
 * Main configuration service for Minsky
 *
 * Integrates all configuration components and provides the primary interface
 * for loading, validating, and resolving configuration across the system.
 */

import {
  ConfigurationService,
  ConfigurationLoadResult,
  ResolvedConfig,
  RepositoryConfig,
  GlobalUserConfig,
  ValidationResult,
  CredentialSource,
} from "./types";
import { ConfigurationLoader } from "./config-loader";
import { DefaultCredentialManager } from "./credential-manager";
import { DefaultBackendDetector } from "./backend-detector";

export class DefaultConfigurationService implements ConfigurationService {
  private loader: ConfigurationLoader;
  private credentialManager: DefaultCredentialManager;
  private backendDetector: DefaultBackendDetector;

  constructor() {
    this.loader = new ConfigurationLoader();
    this.credentialManager = new DefaultCredentialManager();
    this.backendDetector = new DefaultBackendDetector();
  }

  /**
   * Load configuration with full resolution and backend detection
   */
  async loadConfiguration(workingDir: string): Promise<ConfigurationLoadResult> {
    // Load base configuration from all sources
    const result = await this.loader.loadConfiguration(workingDir);

    // Apply backend auto-detection if enabled
    const resolved = await this.applyBackendDetection(workingDir, result.resolved);

    // Resolve credentials
    const finalResolved = await this.resolveCredentials(resolved);

    return {
      resolved: finalResolved,
      sources: result.sources,
    };
  }

  /**
   * Validate repository configuration
   */
  validateRepositoryConfig(config: RepositoryConfig): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];
    const warnings: Array<{ field: string; message: string; code: string }> = [];

    // Version validation
    if (!config.version) {
      errors.push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if (config.version !== 1) {
      errors.push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // Backend validation
    if (config.backends?.default) {
      const validBackends = ["markdown", "json-file", "github-issues"];
      if (!validBackends.includes(config.backends.default)) {
        errors.push({
          field: "backends.default",
          message: `Invalid backend: ${config.backends.default}. Valid options: ${validBackends.join(", ")}`,
          code: "INVALID_BACKEND",
        });
      }

      // GitHub Issues backend validation
      if (config.backends.default === "github-issues") {
        if (!config.backends["github-issues"]?.owner) {
          errors.push({
            field: "backends.github-issues.owner",
            message: "GitHub owner is required for github-issues backend",
            code: "MISSING_GITHUB_OWNER",
          });
        }
        if (!config.backends["github-issues"]?.repo) {
          errors.push({
            field: "backends.github-issues.repo",
            message: "GitHub repository name is required for github-issues backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate global user configuration
   */
  validateGlobalUserConfig(config: GlobalUserConfig): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];
    const warnings: Array<{ field: string; message: string; code: string }> = [];

    // Version validation
    if (!config.version) {
      errors.push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if (config.version !== 1) {
      errors.push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // Credential validation
    if (config.credentials?.github) {
      const github = config.credentials.github;
      const validSources: CredentialSource[] = ["environment", "file", "prompt"];

      if (!validSources.includes(github.source)) {
        errors.push({
          field: "credentials.github.source",
          message: `Invalid credential source: ${github.source}. Valid options: ${validSources.join(", ")}`,
          code: "INVALID_CREDENTIAL_SOURCE",
        });
      }

      if (github.source === "file" && !github.token && !github.token_file) {
        warnings.push({
          field: "credentials.github",
          message: "Neither token nor token_file specified for file-based credential source",
          code: "INCOMPLETE_FILE_CREDENTIALS",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Apply backend auto-detection if enabled
   */
  private async applyBackendDetection(
    workingDir: string,
    config: ResolvedConfig
  ): Promise<ResolvedConfig> {
    // If backend is already explicitly set or auto-detection is disabled, use as-is
    if (!config.detectionRules || config.detectionRules.length === 0) {
      return config;
    }

    // Only auto-detect if we're using the default backend from detection rules
    const defaultBackend =
      config.detectionRules.find((rule) => rule.condition === "always")?.backend || "json-file";
    if (config.backend !== defaultBackend) {
      return config; // Backend was explicitly configured
    }

    // Run detection
    const detectedBackend = await this.backendDetector.detectBackend(
      workingDir,
      config.detectionRules
    );

    return {
      ...config,
      backend: detectedBackend,
    };
  }

  /**
   * Resolve credentials using the credential manager
   */
  private async resolveCredentials(config: ResolvedConfig): Promise<ResolvedConfig> {
    const resolved = { ...config };

    // Resolve GitHub credentials if needed
    if (
      (config.backend === "github-issues" || config.credentials.github) &&
      !config.credentials.github?.token
    ) {
      const githubToken = await this.credentialManager.getCredential("github");
      if (githubToken) {
        resolved.credentials = {
          ...resolved.credentials,
          github: {
            ...resolved.credentials.github,
            token: githubToken,
            source: resolved.credentials.github?.source || "environment",
          },
        };
      }
    }

    return resolved;
  }
}
