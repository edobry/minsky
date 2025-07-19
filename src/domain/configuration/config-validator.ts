/**
 * Configuration Validator Service
 *
 * Validates configuration values using the custom configuration system
 * while preserving existing validation logic and error reporting capabilities.
 */

import { get } from "./index";

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ConfigValidator {
  validateConfiguration(): ValidationResult;
  validateBackend(): ValidationResult;
  validateSessionDb(): ValidationResult;
  validateAI(): ValidationResult;
  validateGitHub(): ValidationResult;
}

export class DefaultConfigValidator implements ConfigValidator {
  /**
   * Validate entire configuration
   */
  validateConfiguration(): ValidationResult {
    const results = [
      this.validateBackend(),
      this.validateSessionDb(),
      this.validateAI(),
      this.validateGitHub(),
    ];

    const allErrors = results.flatMap(r => r.errors);
    const allWarnings = results.flatMap(r => r.warnings);

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }

  /**
   * Validate backend configuration
   */
  validateBackend(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const backend = get("backend") as string;
      const validBackends = ["markdown", "json-file", "github-issues"];

      if (!validBackends.includes(backend)) {
        errors.push({
          field: "backend",
          message: `Invalid backend: ${backend}. Valid options: ${validBackends.join(", ")}`,
          code: "INVALID_BACKEND",
        });
      }

      // Validate backend-specific configuration
      if (backend === "github-issues") {
        const backendConfig = get("backendConfig") as any;
        const githubConfig = backendConfig?.["github-issues"];

        if (!githubConfig?.owner) {
          errors.push({
            field: "backendConfig.github-issues.owner",
            message: "GitHub owner is required for github-issues backend",
            code: "MISSING_GITHUB_OWNER",
          });
        }

        if (!githubConfig?.repo) {
          errors.push({
            field: "backendConfig.github-issues.repo",
            message: "GitHub repository is required for github-issues backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    } catch (error) {
      errors.push({
        field: "backend",
        message: `Error validating backend configuration: ${(error as any).message}`,
        code: "BACKEND_VALIDATION_ERROR",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate session database configuration
   */
  validateSessionDb(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const sessiondb = get("sessiondb") as any;
      const backend = sessiondb?.backend;

      if (!backend) {
        errors.push({
          field: "sessiondb.backend",
          message: "Session database backend is required",
          code: "MISSING_SESSIONDB_BACKEND",
        });
      } else {
        const validBackends = ["json", "sqlite", "postgres"];
        if (!validBackends.includes(backend)) {
          errors.push({
            field: "sessiondb.backend",
            message: `Invalid session database backend: ${backend}. Valid options: ${validBackends.join(", ")}`,
            code: "INVALID_SESSIONDB_BACKEND",
          });
        }

        // Backend-specific validations
        if (backend === "sqlite" && !sessiondb.path) {
          warnings.push({
            field: "sessiondb.path",
            message: "SQLite path not specified, will use default location",
            code: "DEFAULT_SQLITE_PATH",
          });
        }

        if (backend === "postgres") {
          if (!sessiondb.connectionString && !sessiondb.host) {
            errors.push({
              field: "sessiondb.connectionString",
              message: "PostgreSQL connection string or host is required",
              code: "MISSING_POSTGRES_CONNECTION",
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        field: "sessiondb",
        message: `Error validating session database configuration: ${(error as any).message}`,
        code: "SESSIONDB_VALIDATION_ERROR",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate AI configuration
   */
  validateAI(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const ai = get("ai") as any;

      if (ai?.default_provider) {
        const validProviders = ["openai", "anthropic", "ollama"];
        if (!validProviders.includes(ai.default_provider)) {
          errors.push({
            field: "ai.default_provider",
            message: `Invalid AI provider: ${ai.default_provider}. Valid options: ${validProviders.join(", ")}`,
            code: "INVALID_AI_PROVIDER",
          });
        }
      }

      // Validate provider configurations
      if (ai?.providers) {
        for (const [providerName, providerConfig] of Object.entries(ai.providers)) {
          const validationResult = this.validateAIProviderConfig(providerName, providerConfig as any);
          errors.push(...validationResult.errors);
          warnings.push(...validationResult.warnings);
        }
      }
    } catch (error) {
      errors.push({
        field: "ai",
        message: `Error validating AI configuration: ${(error as any).message}`,
        code: "AI_VALIDATION_ERROR",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate GitHub configuration
   */
  validateGitHub(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const github = get("github") as any;

      if (github?.credentials) {
        const validSources = ["env", "file", "keychain", "manual"];
        if (!validSources.includes(github.credentials.source)) {
          errors.push({
            field: "github.credentials.source",
            message: `Invalid credential source: ${github.credentials.source}. Valid options: ${validSources.join(", ")}`,
            code: "INVALID_GITHUB_CREDENTIAL_SOURCE",
          });
        }

        if (github.credentials.source === "file" && !github.credentials.path) {
          errors.push({
            field: "github.credentials.path",
            message: "Credential file path is required when using file source",
            code: "MISSING_GITHUB_CREDENTIAL_PATH",
          });
        }

        if (github.credentials.source === "env" && !github.credentials.env_var) {
          warnings.push({
            field: "github.credentials.env_var",
            message: "Environment variable name not specified, will use default GITHUB_TOKEN",
            code: "DEFAULT_GITHUB_ENV_VAR",
          });
        }
      }
    } catch (error) {
      errors.push({
        field: "github",
        message: `Error validating GitHub configuration: ${(error as any).message}`,
        code: "GITHUB_VALIDATION_ERROR",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate AI provider configuration
   */
  private validateAIProviderConfig(
    providerName: string,
    providerConfig: any
  ): { errors: ValidationError[], warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    // Validate temperature
    if (providerConfig.temperature !== undefined) {
      if (typeof providerConfig.temperature !== "number" || providerConfig.temperature < 0 || providerConfig.temperature > 2) {
        errors.push({
          field: `ai.providers.${providerName}.temperature`,
          message: "Temperature must be a number between 0 and 2",
          code: "INVALID_TEMPERATURE",
        });
      }
    }

    // Validate max_tokens
    if (providerConfig.max_tokens !== undefined) {
      if (typeof providerConfig.max_tokens !== "number" || providerConfig.max_tokens <= 0) {
        errors.push({
          field: `ai.providers.${providerName}.max_tokens`,
          message: "max_tokens must be a positive number",
          code: "INVALID_MAX_TOKENS",
        });
      }
    }

    // Validate credentials
    if (providerConfig.credentials) {
      const validSources = ["env", "file", "keychain", "manual"];
      if (!validSources.includes(providerConfig.credentials.source)) {
        errors.push({
          field: `ai.providers.${providerName}.credentials.source`,
          message: `Invalid credential source: ${providerConfig.credentials.source}. Valid options: ${validSources.join(", ")}`,
          code: "INVALID_CREDENTIAL_SOURCE",
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate PostgreSQL connection string format
   */
  private isValidPostgresConnectionString(connectionString: string): boolean {
    // Basic validation for PostgreSQL connection string format
    const postgresRegex = /^postgresql:\/\/[^:]+:[^@]+@[^:]+:\d+\/[^?]+(\?.*)?$/;
    return postgresRegex.test(connectionString);
  }
}

// Export singleton instance
export const configValidator = new DefaultConfigValidator(); 
