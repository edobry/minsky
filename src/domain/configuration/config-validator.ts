/**
 * Configuration Validator Service
 *
 * Validates configuration values using the custom configuration system
 * while preserving existing validation logic and error reporting capabilities.
 */

import { get } from "./index";
import type { AIConfig, AIProviderConfig } from "./schemas/ai";
import type { GitHubConfig } from "./schemas/github";
import type { BackendConfig } from "./schemas/backend";
import { TaskBackend } from "./backend-detection";
import { getErrorMessage } from "../../schemas/error";

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
    const results = [this.validateBackend(), this.validateAI(), this.validateGitHub()];

    const allErrors = results.flatMap((r) => r.errors);
    const allWarnings = results.flatMap((r) => r.warnings);

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }

  /**
   * Validate backend configuration
   *
   * @deprecated Root backend property is deprecated, now validates tasks.backend instead
   */
  validateBackend(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Use modern tasks.backend instead of deprecated root backend
      const backend = get("tasks.backend") as string;
      const validBackends = Object.values(TaskBackend);

      if (backend && !validBackends.includes(backend as TaskBackend)) {
        errors.push({
          field: "tasks.backend",
          message: `Invalid tasks backend: ${backend}. Valid options: ${validBackends.join(", ")}`,
          code: "INVALID_TASKS_BACKEND",
        });
      }

      // Validate backend-specific configuration (using tasks.backend instead of deprecated root backend)
      if (backend === TaskBackend.GITHUB_ISSUES) {
        const backendConfig = get("backendConfig") as BackendConfig;
        const githubConfig = backendConfig?.["github-issues"];

        if (!githubConfig?.owner) {
          errors.push({
            field: "backendConfig.github-issues.owner",
            message: "GitHub owner is required for github-issues tasks backend",
            code: "MISSING_GITHUB_OWNER",
          });
        }

        if (!githubConfig?.repo) {
          errors.push({
            field: "backendConfig.github-issues.repo",
            message: "GitHub repository is required for github-issues tasks backend",
            code: "MISSING_GITHUB_REPO",
          });
        }
      }
    } catch (error) {
      errors.push({
        field: "tasks.backend",
        message: `Error validating tasks backend configuration: ${getErrorMessage(error)}`,
        code: "TASKS_BACKEND_VALIDATION_ERROR",
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
      const ai = get("ai") as AIConfig;

      if (ai?.defaultProvider) {
        const validProviders = ["openai", "anthropic", "ollama"];
        if (!validProviders.includes(ai.defaultProvider)) {
          errors.push({
            field: "ai.defaultProvider",
            message: `Invalid AI provider: ${ai.defaultProvider}. Valid options: ${validProviders.join(", ")}`,
            code: "INVALID_AI_PROVIDER",
          });
        }
      }

      // Validate provider configurations
      if (ai?.providers) {
        for (const [providerName, providerConfig] of Object.entries(ai.providers)) {
          if (providerConfig == null) continue;
          const validationResult = this.validateAIProviderConfig(
            providerName,
            providerConfig as Record<string, unknown>
          );
          errors.push(...validationResult.errors);
          warnings.push(...validationResult.warnings);
        }
      }
    } catch (error) {
      errors.push({
        field: "ai",
        message: `Error validating AI configuration: ${getErrorMessage(error)}`,
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
   * Validate session database configuration
   */
  validateSessionDb(): ValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Validate GitHub configuration
   */
  validateGitHub(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const github = get("github") as GitHubConfig & Record<string, unknown>;
      const githubCredentials =
        github?.credentials !== null &&
        typeof github?.credentials === "object" &&
        !Array.isArray(github?.credentials)
          ? (github.credentials as Record<string, unknown>)
          : null;

      if (githubCredentials) {
        const validSources = ["env", "file", "keychain", "manual"];
        const credSource = githubCredentials["source"];
        if (typeof credSource !== "string" || !validSources.includes(credSource)) {
          errors.push({
            field: "github.credentials.source",
            message: `Invalid credential source: ${String(credSource)}. Valid options: ${validSources.join(", ")}`,
            code: "INVALID_GITHUB_CREDENTIAL_SOURCE",
          });
        }

        if (credSource === "file" && !githubCredentials["path"]) {
          errors.push({
            field: "github.credentials.path",
            message: "Credential file path is required when using file source",
            code: "MISSING_GITHUB_CREDENTIAL_PATH",
          });
        }

        if (credSource === "env" && !githubCredentials["env_var"]) {
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
        message: `Error validating GitHub configuration: ${getErrorMessage(error)}`,
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
    providerConfig: Record<string, unknown>
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    // Validate temperature
    if (providerConfig.temperature !== undefined) {
      if (
        typeof providerConfig.temperature !== "number" ||
        providerConfig.temperature < 0 ||
        providerConfig.temperature > 2
      ) {
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
    const credentials =
      providerConfig.credentials !== null &&
      typeof providerConfig.credentials === "object" &&
      !Array.isArray(providerConfig.credentials)
        ? (providerConfig.credentials as Record<string, unknown>)
        : null;
    if (credentials) {
      const validSources = ["env", "file", "keychain", "manual"];
      const credentialSource = credentials["source"];
      if (typeof credentialSource !== "string" || !validSources.includes(credentialSource)) {
        errors.push({
          field: `ai.providers.${providerName}.credentials.source`,
          message: `Invalid credential source: ${String(credentialSource)}. Valid options: ${validSources.join(", ")}`,
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
