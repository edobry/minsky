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

import { workflowConfigSchema, type WorkflowConfig } from "./workflow";

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

    // Logging configuration
    logger: loggerConfigSchema,

    // Workflow commands configuration
    workflows: workflowConfigSchema,
  })
  .passthrough();

// Export configuration type
export type Configuration = z.infer<typeof configurationSchema>;

// Export partial configuration type for sources
export type PartialConfiguration = Partial<Configuration>;

// Export domain-specific types
export type {
  Backend,
  BackendConfig,
  DetectionRules,
  SessionDbConfig,
  GitHubConfig,
  AIConfig,
  LoggerConfig,
  WorkflowConfig,
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
  workflowConfigSchema,
};

// Export validation result type
export interface ConfigurationValidationResult {
  success: boolean;
  data?: Configuration;
  error?: z.ZodError;
}
