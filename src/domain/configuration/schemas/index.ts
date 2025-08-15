/**
 * Root Configuration Schema
 *
 * Combines all domain-specific configuration schemas into a complete, type-safe
 * configuration system with validation and TypeScript integration.
 */

import { z } from "zod";

// Import all domain schemas
import {
  backendSchema,
  backendConfigSchema,
  detectionRulesSchema,
  type Backend,
  type BackendConfig,
  type DetectionRules,
} from "./backend";

import { sessionDbConfigSchema, type SessionDbConfig } from "./sessiondb";

import { githubConfigSchema, type GitHubConfig } from "./github";

import { aiConfigSchema, type AIConfig } from "./ai";

import { loggerConfigSchema, type LoggerConfig } from "./logger";

import { validationConfigSchema, type ValidationConfig } from "./validation";
import { tasksConfigSchema, type TasksConfig } from "./tasks";
import { embeddingsConfigSchema, type EmbeddingsConfig } from "./embeddings";

/**
 * Complete application configuration schema
 *
 * This is the root schema that defines the entire configuration structure
 * for the Minsky application, combining all domain-specific configurations.
 */
export const configurationSchema = z
  .object({
    // Backend configuration
    backend: backendSchema,
    backendConfig: backendConfigSchema,
    detectionRules: detectionRulesSchema,

    // Session database configuration
    sessiondb: sessionDbConfigSchema,

    // GitHub integration configuration
    github: githubConfigSchema,

    // AI providers configuration
    ai: aiConfigSchema,

    // Embeddings configuration
    embeddings: embeddingsConfigSchema,

    // Logging configuration
    logger: loggerConfigSchema,

    // Validation configuration
    validation: validationConfigSchema,

    // Tasks configuration
    tasks: tasksConfigSchema,
  })
  .passthrough(); // Use passthrough instead of strict to allow extra properties

/**
 * Configuration type inferred from the schema
 */
export type Configuration = z.infer<typeof configurationSchema>;

/**
 * Deeply partial configuration type for overrides and partial updates
 */
export type PartialConfiguration = z.input<typeof configurationSchema>;

/**
 * Configuration validation result
 */
export interface ConfigurationValidationResult {
  success: boolean;
  data?: Configuration;
  error?: z.ZodError;
  issues?: z.ZodIssue[];
}

/**
 * Configuration validation functions
 */
export const configurationValidation = {
  /**
   * Validate a complete configuration object
   */
  validate: (config: unknown): ConfigurationValidationResult => {
    const result = configurationSchema.safeParse(config);

    if (result.success) {
      return {
        success: true,
        data: result.data,
      };
    } else {
      return {
        success: false,
        error: result.error,
        issues: result.error.issues,
      };
    }
  },

  /**
   * Validate a partial configuration (for overrides)
   */
  validatePartial: (config: unknown): { success: boolean; error?: z.ZodError } => {
    const partialSchema = configurationSchema.deepPartial();
    const result = partialSchema.safeParse(config);

    return {
      success: result.success,
      error: result.success ? undefined : result.error,
    };
  },

  /**
   * Parse configuration with detailed error reporting
   */
  parse: (config: unknown): Configuration => {
    try {
      return configurationSchema.parse(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n");

        throw new Error(`Configuration validation failed:\n${errorMessages}`);
      }
      throw error;
    }
  },

  /**
   * Get human-readable error messages from validation issues
   */
  formatErrors: (issues: z.ZodIssue[]): string[] => {
    return issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    });
  },

  /**
   * Check if configuration has all required fields for a specific domain
   */
  hasRequiredFields: {
    backend: (config: Configuration): boolean => {
      return !!config.backend;
    },

    sessiondb: (config: Configuration): boolean => {
      return !!config.sessiondb?.backend;
    },

    github: (config: Configuration): boolean => {
      // GitHub is optional, but if configured, should have token
      return !config.github || !!(config.github.token || config.github.tokenFile);
    },

    ai: (config: Configuration): boolean => {
      // AI is optional, return true if no providers configured
      if (!config.ai?.providers) return true;

      // Check if at least one provider has an API key
      const providers = config.ai.providers;
      return !!(
        providers.openai?.apiKey ||
        providers.openai?.apiKeyFile ||
        providers.anthropic?.apiKey ||
        providers.anthropic?.apiKeyFile ||
        providers.google?.apiKey ||
        providers.google?.apiKeyFile ||
        providers.cohere?.apiKey ||
        providers.cohere?.apiKeyFile ||
        providers.mistral?.apiKey ||
        providers.mistral?.apiKeyFile
      );
    },

    logger: (config: Configuration): boolean => {
      return !!config.logger?.mode && !!config.logger?.level;
    },
  },

  /**
   * Validate cross-domain configuration consistency
   */
  validateConsistency: (config: Configuration): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    // Check GitHub Issues backend has GitHub configuration
    if (config.backend === "github-issues") {
      if (
        !config.backendConfig["github-issues"]?.owner ||
        !config.backendConfig["github-issues"]?.repo
      ) {
        errors.push("GitHub Issues backend requires owner and repo in backendConfig");
      }

      if (!config.github?.token && !config.github?.tokenFile) {
        errors.push("GitHub Issues backend requires GitHub token configuration");
      }
    }

    // Check SessionDB PostgreSQL has connection string
    if (config.sessiondb?.backend === "postgres") {
      const hasConnectionString = !!(
        config.sessiondb.postgres?.connectionString || config.sessiondb.connectionString
      );

      if (!hasConnectionString) {
        errors.push("PostgreSQL SessionDB backend requires connection string");
      }
    }

    // Check AI default provider is enabled
    if (config.ai?.defaultProvider) {
      const providerConfig = config.ai.providers?.[config.ai.defaultProvider];
      if (!providerConfig?.enabled) {
        errors.push(`Default AI provider '${config.ai.defaultProvider}' is not enabled`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
} as const;

// Re-export all types for convenience
export type {
  Backend,
  BackendConfig,
  DetectionRules,
  SessionDbConfig,
  GitHubConfig,
  AIConfig,
  LoggerConfig,
  TasksConfig,
  EmbeddingsConfig,
};

// Re-export schemas for external use
export {
  backendSchema,
  backendConfigSchema,
  detectionRulesSchema,
  sessionDbConfigSchema,
  githubConfigSchema,
  aiConfigSchema,
  loggerConfigSchema,
  tasksConfigSchema,
  embeddingsConfigSchema,
};

// Export the main schema as default
export default configurationSchema;
