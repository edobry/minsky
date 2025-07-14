/**
 * Configuration Validator Service for Node-Config Integration
 *
 * Validates configuration values resolved by node-config while preserving
 * existing validation logic and error reporting capabilities.
 */

import config from "config";

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
      const backend = config.get("backend") as string;
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
        const backendConfig = config.get("backendConfig") as any;
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
            message: "GitHub repository name is required for github-issues backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    } catch (error) {
      errors.push({
        field: "backend",
        message: "Backend configuration is missing or invalid",
        code: "MISSING_BACKEND",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate SessionDB configuration
   */
  validateSessionDb(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const sessiondb = config.get("sessiondb") as any;
      const backend = sessiondb?.backend;

      if (backend) {
        const validBackends = ["json", "sqlite", "postgres"];
        if (!validBackends.includes(backend)) {
          errors.push({
            field: "sessiondb.backend",
            message: `Invalid SessionDB backend: ${backend}. Valid options: ${validBackends.join(", ")}`,
            code: "INVALID_SESSIONDB_BACKEND",
          });
        }

        // Validate backend-specific configuration
        if (backend === "sqlite" && sessiondb?.sqlite?.path === "") {
          errors.push({
            field: "sessiondb.sqlite.path",
            message: "SQLite path cannot be empty",
            code: "EMPTY_FILE_PATH",
          });
        }

        if (backend === "postgres") {
          const connectionString = sessiondb?.postgres?.connectionString;
          if (connectionString && !this.isValidPostgresConnectionString(connectionString)) {
            errors.push({
              field: "sessiondb.postgres.connectionString",
              message: "Invalid PostgreSQL connection string format",
              code: "INVALID_CONNECTION_STRING_FORMAT",
            });
          }
        }
      }
    } catch (error) {
      // SessionDB configuration is optional, so no error if missing
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
      const ai = config.get("ai") as any;
      
      if (ai?.default_provider) {
        const validProviders = ["openai", "anthropic", "google", "cohere", "mistral"];
        if (!validProviders.includes(ai.default_provider)) {
          errors.push({
            field: "ai.default_provider",
            message: `Invalid AI provider: ${ai.default_provider}. Valid options: ${validProviders.join(", ")}`,
            code: "INVALID_AI_PROVIDER",
          });
        }
      }

      // Validate provider-specific configuration
      if (ai?.providers) {
        for (const [providerName, providerConfig] of Object.entries(ai.providers)) {
          if (providerConfig && typeof providerConfig === "object") {
            this.validateAIProviderConfig(providerConfig as any, errors, warnings, `ai.providers.${providerName}`);
          }
        }
      }
    } catch (error) {
      // AI configuration is optional, so no error if missing
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
      const github = config.get("github") as any;
      
      if (github?.credentials) {
        const validSources = ["environment", "file", "prompt"];
        if (!validSources.includes(github.credentials.source)) {
          errors.push({
            field: "github.credentials.source",
            message: `Invalid credential source: ${github.credentials.source}. Valid options: ${validSources.join(", ")}`,
            code: "INVALID_CREDENTIAL_SOURCE",
          });
        }

        if (github.credentials.source === "file" && !github.credentials.token && !github.credentials.token_file) {
          warnings.push({
            field: "github.credentials",
            message: "Neither token nor token_file specified for file-based credential source",
            code: "INCOMPLETE_FILE_CREDENTIALS",
          });
        }
      }
    } catch (error) {
      // GitHub configuration is optional, so no error if missing
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
    providerConfig: any,
    errors: ValidationError[],
    warnings: ValidationWarning[],
    fieldPrefix: string
  ): void {
    // Validate temperature
    if (providerConfig.temperature !== undefined) {
      if (typeof providerConfig.temperature !== "number" || providerConfig.temperature < 0 || providerConfig.temperature > 2) {
        errors.push({
          field: `${fieldPrefix}.temperature`,
          message: "Temperature must be a number between 0 and 2",
          code: "INVALID_TEMPERATURE",
        });
      }
    }

    // Validate max_tokens
    if (providerConfig.max_tokens !== undefined) {
      if (typeof providerConfig.max_tokens !== "number" || providerConfig.max_tokens <= 0) {
        errors.push({
          field: `${fieldPrefix}.max_tokens`,
          message: "max_tokens must be a positive number",
          code: "INVALID_MAX_TOKENS",
        });
      }
    }

    // Validate credentials
    if (providerConfig.credentials) {
      const validSources = ["environment", "file", "prompt"];
      if (!validSources.includes(providerConfig.credentials.source)) {
        errors.push({
          field: `${fieldPrefix}.credentials.source`,
          message: `Invalid credential source: ${providerConfig.credentials.source}. Valid options: ${validSources.join(", ")}`,
          code: "INVALID_CREDENTIAL_SOURCE",
        });
      }
    }
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
