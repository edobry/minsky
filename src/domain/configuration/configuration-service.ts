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
    const result = await (this.loader as any).loadConfiguration(workingDir);

    // Apply backend auto-detection if enabled
    const resolved = await this.applyBackendDetection(workingDir, (result as any).resolved);

    // Resolve credentials
    const finalResolved = await this.resolveCredentials(resolved);

    return {
      resolved: finalResolved,
      sources: (result as any).sources,
    } as any;
  }

  /**
   * Validate repository configuration
   */
  validateRepositoryConfig(config: RepositoryConfig): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];
    const warnings: Array<{ field: string; message: string; code: string }> = [];

    // Version validation
    if (!(config as any).version) {
      (errors as any).push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if ((config as any).version !== 1) {
      (errors as any).push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // Backend validation
    if ((config as any).backends && (config.backends as any).default) {
      const validBackends = ["markdown", "json-file", "github-issues"];
      if (!(validBackends as any).includes((config.backends as any).default)) {
        (errors as any).push({
          field: "backends.default",
          message: `Invalid backend: ${(config.backends as any).default}. Valid options: ${(validBackends as any).join(", ")}`,
          code: "INVALID_BACKEND",
        });
      }

      // GitHub Issues backend validation
      if ((config.backends as any).default === "github-issues") {
        if (!((config.backends as any)["github-issues"] as any).owner) {
          (errors as any).push({
            field: "backends.github-issues.owner",
            message: "GitHub owner is required for github-issues backend",
            code: "MISSING_GITHUB_OWNER",
          });
        }
        if (!((config.backends as any)["github-issues"] as any).repo) {
          (errors as any).push({
            field: "backends.github-issues.repo",
            message: "GitHub repository name is required for github-issues backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    }

    return {
      valid: (errors as any).length === 0,
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
    if (!(config as any).version) {
      (errors as any).push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if ((config as any).version !== 1) {
      (errors as any).push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // GitHub credential validation
    if ((config as any).github && (config.github as any).credentials) {
      const github = (config.github as any).credentials;
      const validSources: CredentialSource[] = ["environment", "file", "prompt"];

      if (!(validSources as any).includes(github.source)) {
        (errors as any).push({
          field: "github.credentials.source",
          message: `Invalid credential source: ${github.source}. Valid options: ${(validSources as any).join(", ")}`,
          code: "INVALID_CREDENTIAL_SOURCE",
        });
      }

      if (github.source === "file" && !(github as any).token && !github.token_file) {
        (warnings as any).push({
          field: "github.credentials",
          message: "Neither token nor token_file specified for file-based credential source",
          code: "INCOMPLETE_FILE_CREDENTIALS",
        });
      }
    }

    return {
      valid: (errors as any).length === 0,
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
    if (!(config as any).detectionRules || (config.detectionRules as any).length === 0) {
      return config;
    }

    // Only auto-detect if we're using the default backend from detection rules
    const defaultBackend =
      (config.detectionRules.find((rule) => rule.condition === "always" as any) as any).backend || "json-file";
    if ((config as any).backend !== defaultBackend) {
      return config; // Backend was explicitly configured
    }

    // Run detection
    const detectedBackend = await (this.backendDetector as any).detectBackend(
      workingDir,
      (config as any).detectionRules
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
      ((config as any).backend === "github-issues" || (config.github as any).credentials) &&
      !(config?.github?.credentials as any).token
    ) {
      const githubToken = await (this.credentialManager as any).getCredential("github");
      if (githubToken) {
        (resolved as any).github = {
          ...(resolved as any).github,
          credentials: {
            ...(resolved.github as any).credentials,
            token: githubToken,
            source: (resolved.github?.credentials as any).source || "environment",
          },
        };
      }
    }

    return resolved;
  }
}
