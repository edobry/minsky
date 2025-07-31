/**
 * Base Schema Types for Configuration System
 *
 * Common validation patterns and utility schemas used across all configuration domains.
 * Provides reusable building blocks for complex configuration schemas.
 */

import { z } from "zod";

/**
 * Common string validation patterns
 */
export const baseSchemas = {
  // File path validation
  filePath: z.string().min(1, "File path cannot be empty"),

  // URL validation with proper format checking
  url: z.string().url("Must be a valid URL"),

  // Port number validation
  port: z.number().int().min(1).max(65535, "Port must be between 1 and 65535"),

  // Non-empty string (common for tokens, names, etc.)
  nonEmptyString: z.string().min(1, "Value cannot be empty"),

  // Optional non-empty string (either undefined or non-empty)
  optionalNonEmptyString: z.string().min(1).optional(),

  // Environment variable name pattern
  envVarName: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Must be a valid environment variable name"),

  // Directory path (can be relative or absolute)
  directoryPath: z.string().min(1, "Directory path cannot be empty"),

  // Connection string for databases
  connectionString: z.string().min(1, "Connection string cannot be empty"),

  // PostgreSQL connection string with format validation
  postgresConnectionString: z
    .string()
    .regex(
      /^postgresql:\/\/[^:]+:[^@]+@[^:]+:\d+\/[^?]+(\?.*)?$/,
      "Must be a valid PostgreSQL connection string"
    ),

  // SQLite file path
  sqliteFilePath: z.string().min(1, "SQLite file path cannot be empty"),

  // API key pattern (typically alphanumeric with some special chars)
  apiKey: z.string().min(1, "API key cannot be empty"),

  // Temperature for AI models (0-2 range)
  temperature: z.number().min(0).max(2, "Temperature must be between 0 and 2"),

  // Max tokens for AI models (positive integer)
  maxTokens: z.number().int().positive("Max tokens must be a positive integer"),

  // Model name (non-empty string)
  modelName: z.string().min(1, "Model name cannot be empty"),

  // Organization name
  organizationName: z.string().min(1, "Organization name cannot be empty"),

  // Repository name
  repositoryName: z.string().min(1, "Repository name cannot be empty"),
} as const;

/**
 * Enum schemas for common configuration options
 */
export const enumSchemas = {
  // Log levels
  logLevel: z.enum(["debug", "info", "warn", "error"], {
    errorMap: () => ({ message: "Log level must be one of: debug, info, warn, error" }),
  }),

  // Logger modes
  loggerMode: z.enum(["HUMAN", "STRUCTURED", "auto"], {
    errorMap: () => ({ message: "Logger mode must be one of: HUMAN, STRUCTURED, auto" }),
  }),

  // Backend types
  backendType: z.enum(["markdown", "json-file", "github-issues"], {
    errorMap: () => ({ message: "Backend must be one of: markdown, json-file, github-issues" }),
  }),

  // SessionDB backends
  sessionDbBackend: z.enum(["json", "sqlite", "postgres"], {
    errorMap: () => ({ message: "SessionDB backend must be one of: json, sqlite, postgres" }),
  }),

  // AI providers
  aiProvider: z.enum(["openai", "anthropic", "google", "cohere", "mistral", "morph"], {
    errorMap: () => ({
      message: "AI provider must be one of: openai, anthropic, google, cohere, mistral, morph",
    }),
  }),

  // Detection rule conditions
  detectionCondition: z.enum(["tasks_md_exists", "json_file_exists", "always"], {
    errorMap: () => ({
      message: "Detection condition must be one of: tasks_md_exists, json_file_exists, always",
    }),
  }),
} as const;

/**
 * Utility functions for schema composition
 */
export const schemaUtils = {
  /**
   * Create an optional schema that accepts undefined or the provided schema
   */
  optional: <T extends z.ZodTypeAny>(schema: T) => schema.optional(),

  /**
   * Create a schema with a default value
   */
  withDefault: <T extends z.ZodTypeAny, D>(schema: T, defaultValue: D) =>
    schema.default(defaultValue),

  /**
   * Create a deeply partial version of an object schema (for configuration overrides)
   */
  deepPartial: (schema: z.ZodObject<any>) => schema.deepPartial(),

  /**
   * Create a schema that validates environment variable format and converts to the target type
   */
  fromEnvVar: <T extends z.ZodTypeAny>(schema: T, envVarName: string) =>
    z
      .string()
      .optional()
      .transform((val, ctx) => {
        if (!val) return undefined;

        const result = schema.safeParse(val);
        if (!result.success) {
          result.error.issues.forEach((issue) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Environment variable ${envVarName}: ${issue.message}`,
              path: issue.path,
            });
          });
          return z.NEVER;
        }

        return result.data;
      }),
} as const;

/**
 * Credential configuration schema (used across multiple domains)
 */
export const credentialSourceSchema = z.enum(["environment", "file", "prompt"], {
  errorMap: () => ({ message: "Credential source must be one of: environment, file, prompt" }),
});

export const credentialConfigSchema = z
  .object({
    source: credentialSourceSchema,
    token: baseSchemas.optionalNonEmptyString,
    tokenFile: baseSchemas.optionalNonEmptyString,
    apiKey: baseSchemas.optionalNonEmptyString,
    apiKeyFile: baseSchemas.optionalNonEmptyString,
  })
  .strict();

/**
 * File configuration schema for loading from YAML/JSON files
 */
export const fileConfigSchema = z
  .object({
    path: baseSchemas.filePath,
    required: z.boolean().default(false),
    format: z.enum(["yaml", "json", "auto"]).default("auto"),
  })
  .strict();

/**
 * Environment variable mapping schema
 */
export const envVarMappingSchema = z
  .object({
    name: baseSchemas.envVarName,
    path: z.string().min(1, "Configuration path cannot be empty"),
    transform: z.enum(["string", "number", "boolean", "json"]).default("string"),
  })
  .strict();

export type CredentialConfig = z.infer<typeof credentialConfigSchema>;
export type FileConfig = z.infer<typeof fileConfigSchema>;
export type EnvVarMapping = z.infer<typeof envVarMappingSchema>;

/**
 * Re-export commonly used types for convenience
 */
export type {
  ZodSchema,
  ZodType,
  ZodTypeAny,
  ZodObject,
  ZodEnum,
  ZodString,
  ZodNumber,
  ZodBoolean,
  ZodOptional,
  ZodDefault,
  ZodArray,
} from "zod";
