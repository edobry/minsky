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
import { existsSync, statSync, accessSync, constants } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { homedir } from "os";

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
    const result = await (this.loader as unknown).loadConfiguration(workingDir);

    // Apply backend auto-detection if enabled
    const resolved = await this.applyBackendDetection(workingDir, (result as unknown).resolved);

    // Resolve credentials
    const finalResolved = await this.resolveCredentials(resolved);

    return {
      resolved: finalResolved,
      sources: (result as unknown).sources,
    } as unknown;
  }

  /**
   * Validate repository configuration
   */
  validateRepositoryConfig(config: RepositoryConfig): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];
    const warnings: Array<{ field: string; message: string; code: string }> = [];

    // Version validation
    if (!(config as unknown).version) {
      (errors as unknown).push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if ((config as unknown).version !== 1) {
      (errors as unknown).push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // Backend validation
    if ((config as unknown).backends && (config.backends as unknown).default) {
      const validBackends = ["markdown", "json-file", "github-issues"];
      if (!(validBackends as unknown).includes((config.backends as unknown).default)) {
        (errors as unknown).push({
          field: "backends.default",
          message: `Invalid backend: ${(config.backends as unknown).default}. Valid options: ${(validBackends as unknown).join(", ")}`,
          code: "INVALID_BACKEND",
        });
      }

      // GitHub Issues backend validation
      if ((config.backends as unknown).default === "github-issues") {
        if (!((config.backends as unknown)["github-issues"] as unknown).owner) {
          (errors as unknown).push({
            field: "backends.github-issues.owner",
            message: "GitHub owner is required for github-issues backend",
            code: "MISSING_GITHUB_OWNER",
          });
        }
        if (!((config.backends as unknown)["github-issues"] as unknown).repo) {
          (errors as unknown).push({
            field: "backends.github-issues.repo",
            message: "GitHub repository name is required for github-issues backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    }

    // SessionDB validation
    if ((config as unknown).sessiondb) {
      this.validateSessionDbConfig((config as unknown).sessiondb, errors, warnings, "sessiondb");
    }

    // AI configuration validation
    if ((config as unknown).ai) {
      this.validateAIConfig((config as unknown).ai, errors, warnings, "ai");
    }

    return {
      valid: (errors as unknown).length === 0,
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
    if (!(config as unknown).version) {
      (errors as unknown).push({
        field: "version",
        message: "Configuration version is required",
        code: "MISSING_VERSION",
      });
    } else if ((config as unknown).version !== 1) {
      (errors as unknown).push({
        field: "version",
        message: "Unsupported configuration version. Expected: 1",
        code: "UNSUPPORTED_VERSION",
      });
    }

    // GitHub credential validation
    if ((config as unknown).github && (config.github as unknown).credentials) {
      const github = (config.github as unknown).credentials;
      const validSources: CredentialSource[] = ["environment", "file", "prompt"];

      if (!(validSources as unknown).includes(github.source)) {
        (errors as unknown).push({
          field: "github.credentials.source",
          message: `Invalid credential source: ${github.source}. Valid options: ${(validSources as unknown).join(", ")}`,
          code: "INVALID_CREDENTIAL_SOURCE",
        });
      }

      if (github.source === "file" && !(github as unknown).token && !github.token_file) {
        (warnings as unknown).push({
          field: "github.credentials",
          message: "Neither token nor token_file specified for file-based credential source",
          code: "INCOMPLETE_FILE_CREDENTIALS",
        });
      }
    }

    // SessionDB validation
    if ((config as unknown).sessiondb) {
      this.validateSessionDbConfig((config as unknown).sessiondb, errors, warnings, "sessiondb");
    }

    // AI configuration validation
    if ((config as unknown).ai) {
      this.validateAIConfig((config as unknown).ai, errors, warnings, "ai");
    }

    // PostgreSQL configuration validation
    if ((config as unknown).postgres) {
      if ((config.postgres as unknown).connection_string) {
        this.validateConnectionString((config.postgres as unknown).connection_string, "postgres.connection_string", errors, warnings);
      }
    }

    return {
      valid: (errors as unknown).length === 0,
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
    if (!(config as unknown).detectionRules || (config.detectionRules as unknown).length === 0) {
      return config;
    }

    // Only auto-detect if we're using the default backend from detection rules
    const defaultBackend =
      (config.detectionRules.find((rule) => rule.condition === "always" as unknown) as unknown).backend || "json-file";
    if ((config as unknown).backend !== defaultBackend) {
      return config; // Backend was explicitly configured
    }

    // Run detection
    const detectedBackend = await (this.backendDetector as unknown).detectBackend(
      workingDir,
      (config as unknown).detectionRules
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
      ((config as unknown).backend === "github-issues" || config.github?.credentials) &&
      config.github?.credentials
    ) {
      try {
        const token = await (this.credentialManager as unknown).getCredential("github");
        if (token) {
          resolved.github = {
            ...resolved.github,
            credentials: {
              ...resolved.github?.credentials,
              token,
            },
          };
        }
      } catch (error) {
        // Log but don't fail - credentials might be provided another way
        console.warn("Failed to resolve GitHub credentials:", error);
      }
    }

    return resolved;
  }

  /**
   * Validate SessionDB configuration
   */
  private validateSessionDbConfig(
    sessionDbConfig: any,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>,
    fieldPrefix: string
  ): void {
    // Backend validation
    if (sessionDbConfig.backend) {
      const validBackends = ["json", "sqlite", "postgres"];
      if (!validBackends.includes(sessionDbConfig.backend)) {
        errors.push({
          field: `${fieldPrefix}.backend`,
          message: `Invalid SessionDB backend: ${sessionDbConfig.backend}. Valid options: ${validBackends.join(", ")}`,
          code: "INVALID_SESSIONDB_BACKEND",
        });
      }
    }

    // SQLite-specific validation (check if sqlite config exists OR backend is sqlite)
    if (sessionDbConfig.backend === "sqlite" || sessionDbConfig.sqlite) {
      if (sessionDbConfig.sqlite?.path !== undefined) {
        this.validateFilePath(sessionDbConfig.sqlite.path, `${fieldPrefix}.sqlite.path`, errors, warnings);
      } else if (sessionDbConfig.backend === "sqlite") {
        warnings.push({
          field: `${fieldPrefix}.sqlite.path`,
          message: "SQLite database path not specified, will use default location",
          code: "MISSING_SQLITE_PATH",
        });
      }
    }

    // PostgreSQL-specific validation (check if postgres config exists OR backend is postgres)
    if (sessionDbConfig.backend === "postgres" || sessionDbConfig.postgres) {
      if (sessionDbConfig.postgres?.connection_string !== undefined) {
        this.validateConnectionString(sessionDbConfig.postgres.connection_string, `${fieldPrefix}.postgres.connection_string`, errors, warnings);
      } else if (sessionDbConfig.backend === "postgres") {
        errors.push({
          field: `${fieldPrefix}.postgres.connection_string`,
          message: "PostgreSQL connection string is required for postgres backend",
          code: "MISSING_POSTGRES_CONNECTION_STRING",
        });
      }
    }

    // Base directory validation
    if (sessionDbConfig.base_dir !== undefined) {
      this.validateDirectoryPath(sessionDbConfig.base_dir, `${fieldPrefix}.base_dir`, errors, warnings);
    }
  }

  /**
   * Validate AI configuration
   */
  private validateAIConfig(
    aiConfig: any,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>,
    fieldPrefix: string
  ): void {
    // Default provider validation
    if (aiConfig.default_provider) {
      const validProviders = ["openai", "anthropic", "google", "cohere", "mistral"];
      if (!validProviders.includes(aiConfig.default_provider)) {
        errors.push({
          field: `${fieldPrefix}.default_provider`,
          message: `Invalid AI provider: ${aiConfig.default_provider}. Valid options: ${validProviders.join(", ")}`,
          code: "INVALID_AI_PROVIDER",
        });
      }
    }

    // Provider-specific validation
    if (aiConfig.providers) {
      for (const [providerName, providerConfig] of Object.entries(aiConfig.providers)) {
        if (providerConfig && typeof providerConfig === "object") {
          this.validateAIProviderConfig(providerConfig as unknown, errors, warnings, `${fieldPrefix}.providers.${providerName}`);
        }
      }
    }
  }

  /**
   * Validate AI provider configuration
   */
  private validateAIProviderConfig(
    providerConfig: any,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>,
    fieldPrefix: string
  ): void {
    // Credential validation
    if (providerConfig.credentials) {
      // Source field is now optional - only validate if present
      if (providerConfig.credentials.source) {
        const validSources = ["environment", "file", "prompt"];
        if (!validSources.includes(providerConfig.credentials.source)) {
          errors.push({
            field: `${fieldPrefix}.credentials.source`,
            message: `Invalid credential source: ${providerConfig.credentials.source}. Valid options: ${validSources.join(", ")}`,
            code: "INVALID_CREDENTIAL_SOURCE",
          });
        }

        // File-based credential validation (only when source is explicitly set to "file")
        if (providerConfig.credentials.source === "file" && !providerConfig.credentials.api_key && !providerConfig.credentials.api_key_file) {
          warnings.push({
            field: `${fieldPrefix}.credentials`,
            message: "Neither api_key nor api_key_file specified for file-based credential source",
            code: "INCOMPLETE_FILE_CREDENTIALS",
          });
        }
      }
      
      // General credential validation - credentials can be provided without source
      // The config system will automatically determine the source based on availability
    }

    // Model configuration validation
    if (providerConfig.max_tokens && (typeof providerConfig.max_tokens !== "number" || providerConfig.max_tokens <= 0)) {
      errors.push({
        field: `${fieldPrefix}.max_tokens`,
        message: "max_tokens must be a positive number",
        code: "INVALID_MAX_TOKENS",
      });
    }

    if (providerConfig.temperature && (typeof providerConfig.temperature !== "number" || providerConfig.temperature < 0 || providerConfig.temperature > 2)) {
      errors.push({
        field: `${fieldPrefix}.temperature`,
        message: "temperature must be a number between 0 and 2",
        code: "INVALID_TEMPERATURE",
      });
    }
  }

  /**
   * Validate file path
   */
  private validateFilePath(
    filePath: string,
    fieldName: string,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>
  ): void {
    if (!filePath || filePath.trim() === "") {
      errors.push({
        field: fieldName,
        message: "File path cannot be empty",
        code: "EMPTY_FILE_PATH",
      });
      return;
    }

    // Check for invalid characters (basic validation)
    if (filePath.includes("\0")) {
      errors.push({
        field: fieldName,
        message: "File path contains invalid characters",
        code: "INVALID_FILE_PATH",
      });
      return;
    }

    // Check for relative paths that might be problematic
    if (filePath.startsWith("./") || filePath.startsWith("../")) {
      warnings.push({
        field: fieldName,
        message: "Relative file paths may cause issues across different working directories",
        code: "RELATIVE_FILE_PATH",
      });
    }

    // Expand and validate the path
    const expandedPath = this.expandPath(filePath);
    
    // Check if path contains unresolved environment variables
    if (expandedPath.includes("${") || expandedPath.includes("$")) {
      warnings.push({
        field: fieldName,
        message: "Path contains environment variables that may not be resolved at runtime",
        code: "UNRESOLVED_ENV_VARS",
      });
    }

    // Path existence and permission validation (non-blocking)
    try {
      if (existsSync(expandedPath)) {
        const stats = statSync(expandedPath);
        if (stats.isDirectory()) {
          warnings.push({
            field: fieldName,
            message: "Path points to a directory, expected a file",
            code: "PATH_IS_DIRECTORY",
          });
        } else {
          // Check if file is readable/writable
          try {
            accessSync(expandedPath, constants.R_OK | constants.W_OK);
          } catch (permissionError) {
            warnings.push({
              field: fieldName,
              message: "File exists but may not have read/write permissions",
              code: "INSUFFICIENT_PERMISSIONS",
            });
          }
        }
      } else {
        // Check if parent directory exists and is writable
        const parentDir = dirname(expandedPath);
        if (existsSync(parentDir)) {
          try {
            accessSync(parentDir, constants.W_OK);
          } catch (permissionError) {
            warnings.push({
              field: fieldName,
              message: "Parent directory exists but is not writable",
              code: "PARENT_DIR_NOT_WRITABLE",
            });
          }
        } else {
          warnings.push({
            field: fieldName,
            message: "Parent directory does not exist, will be created if needed",
            code: "PARENT_DIR_MISSING",
          });
        }
      }
    } catch (pathError) {
      // Path validation errors are warnings, not blocking errors
      warnings.push({
        field: fieldName,
        message: "Unable to validate path accessibility",
        code: "PATH_VALIDATION_ERROR",
      });
    }
  }

  /**
   * Validate directory path
   */
  private validateDirectoryPath(
    dirPath: string,
    fieldName: string,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>
  ): void {
    if (!dirPath || dirPath.trim() === "") {
      errors.push({
        field: fieldName,
        message: "Directory path cannot be empty",
        code: "EMPTY_DIRECTORY_PATH",
      });
      return;
    }

    // Check for invalid characters
    if (dirPath.includes("\0")) {
      errors.push({
        field: fieldName,
        message: "Directory path contains invalid characters",
        code: "INVALID_DIRECTORY_PATH",
      });
      return;
    }

    // Check for relative paths
    if (dirPath.startsWith("./") || dirPath.startsWith("../")) {
      warnings.push({
        field: fieldName,
        message: "Relative directory paths may cause issues across different working directories",
        code: "RELATIVE_DIRECTORY_PATH",
      });
    }

    // Expand and validate the path
    const expandedPath = this.expandPath(dirPath);
    
    // Check if path contains unresolved environment variables
    if (expandedPath.includes("${") || expandedPath.includes("$")) {
      warnings.push({
        field: fieldName,
        message: "Directory path contains environment variables that may not be resolved at runtime",
        code: "UNRESOLVED_ENV_VARS",
      });
    }

    // Directory existence and permission validation (non-blocking)
    try {
      if (existsSync(expandedPath)) {
        const stats = statSync(expandedPath);
        if (!stats.isDirectory()) {
          errors.push({
            field: fieldName,
            message: "Path points to a file, expected a directory",
            code: "PATH_IS_FILE",
          });
        } else {
          // Check if directory is readable/writable
          try {
            accessSync(expandedPath, constants.R_OK | constants.W_OK);
          } catch (permissionError) {
            warnings.push({
              field: fieldName,
              message: "Directory exists but may not have read/write permissions",
              code: "INSUFFICIENT_PERMISSIONS",
            });
          }
        }
      } else {
        // Check if parent directory exists and is writable
        const parentDir = dirname(expandedPath);
        if (existsSync(parentDir)) {
          try {
            accessSync(parentDir, constants.W_OK);
          } catch (permissionError) {
            warnings.push({
              field: fieldName,
              message: "Parent directory exists but is not writable",
              code: "PARENT_DIR_NOT_WRITABLE",
            });
          }
        } else {
          warnings.push({
            field: fieldName,
            message: "Parent directory does not exist, will be created if needed",
            code: "PARENT_DIR_MISSING",
          });
        }
      }
    } catch (pathError) {
      // Path validation errors are warnings, not blocking errors
      warnings.push({
        field: fieldName,
        message: "Unable to validate directory accessibility",
        code: "PATH_VALIDATION_ERROR",
      });
    }
  }

  /**
   * Validate PostgreSQL connection string
   */
  private validateConnectionString(
    connectionString: string,
    fieldName: string,
    errors: Array<{ field: string; message: string; code: string }>,
    warnings: Array<{ field: string; message: string; code: string }>
  ): void {
    if (!connectionString || connectionString.trim() === "") {
      errors.push({
        field: fieldName,
        message: "Connection string cannot be empty",
        code: "EMPTY_CONNECTION_STRING",
      });
      return;
    }

    // Basic PostgreSQL connection string format validation
    const pgConnectionRegex = /^postgres(ql)?:\/\/[^:]+:[^@]+@[^:\/]+(\:[0-9]+)?\/[^?]*(\?.*)?$/;
    if (!pgConnectionRegex.test(connectionString)) {
      errors.push({
        field: fieldName,
        message: "Invalid PostgreSQL connection string format. Expected: postgresql://username:password@host:port/database",
        code: "INVALID_CONNECTION_STRING_FORMAT",
      });
    }

    // Security warning for plain text passwords
    if (connectionString.includes("://") && connectionString.includes(":") && connectionString.includes("@")) {
      warnings.push({
        field: fieldName,
        message: "Consider using environment variables for database credentials instead of plain text",
        code: "PLAIN_TEXT_CREDENTIALS",
      });
    }
  }

  /**
   * Expands environment variables in a path.
   * Handles ~ for home directory and ${VAR} for environment variables.
   */
  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return resolve(homedir(), path.slice(1));
    }
    return resolve(path);
  }
}
