/**
 * Environment Variable Configuration Source
 *
 * Maps environment variables to configuration values using automatic pattern matching and explicit mappings. Provides the highest priority configuration source.
 */

import type { PartialConfiguration } from "../schemas";

/**
 * Environment variable to configuration path mappings
 *
 * These mappings define how environment variables are translated into
 * configuration object paths.
 */
export const environmentMappings = {
  // Backend configuration
  MINSKY_BACKEND: "backend",

  // Workspace configuration (NEW)
  MINSKY_WORKSPACE_MAIN_PATH: "workspace.mainPath",

  // GitHub configuration
  GITHUB_TOKEN: "github.token",
  GH_TOKEN: "github.token", // Fallback for GitHub CLI
  GITHUB_ORGANIZATION: "github.organization",
  GITHUB_REPOSITORY: "github.repository",
  GITHUB_BASE_URL: "github.baseUrl",
  GITHUB_API_URL: "github.baseUrl",

  // AI provider configuration
  OPENAI_API_KEY: "ai.providers.openai.apiKey",
  OPENAI_ORGANIZATION: "ai.providers.openai.organization",
  OPENAI_BASE_URL: "ai.providers.openai.baseUrl",

  ANTHROPIC_API_KEY: "ai.providers.anthropic.apiKey",
  ANTHROPIC_BASE_URL: "ai.providers.anthropic.baseUrl",

  GOOGLE_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_AI_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_PROJECT_ID: "ai.providers.google.projectId",

  COHERE_API_KEY: "ai.providers.cohere.apiKey",

  MISTRAL_API_KEY: "ai.providers.mistral.apiKey",

  AI_DEFAULT_PROVIDER: "ai.defaultProvider",

  // SessionDB configuration
  MINSKY_SESSIONDB_BACKEND: "sessiondb.backend",
  MINSKY_SESSIONDB_SQLITE_PATH: "sessiondb.sqlite.path",
  MINSKY_SESSIONDB_POSTGRES_URL: "sessiondb.postgres.connectionString",
  MINSKY_SESSIONDB_BASE_DIR: "sessiondb.baseDir",

  // Logger configuration
  MINSKY_LOG_MODE: "logger.mode",
  LOG_MODE: "logger.mode",
  LOGLEVEL: "logger.level",
  LOG_LEVEL: "logger.level",
  MINSKY_LOG_LEVEL: "logger.level",
  ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  MINSKY_ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  LOG_FILE: "logger.logFile",
  MINSKY_LOG_FILE: "logger.logFile",
} as const;

/**
 * Type conversion functions for environment variables
 */
const typeConverters = {
  string: (value: string): string => value,
  number: (value: string): number => Number(value),
  boolean: (value: string): boolean => {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  },
  json: (value: string): any => {
    try {
      return JSON.parse(value);
    } catch {
      return value; // Fall back to string if JSON parsing fails
    }
  },
} as const;

/**
 * Field type mappings for automatic conversion
 */
const fieldTypes: Record<string, keyof typeof typeConverters> = {
  // Numbers
  "logger.maxFileSize": "number",
  "logger.maxFiles": "number",
  "ai.providers.openai.maxTokens": "number",
  "ai.providers.anthropic.maxTokens": "number",
  "ai.providers.google.maxTokens": "number",
  "ai.providers.cohere.maxTokens": "number",
  "ai.providers.mistral.maxTokens": "number",
  "ai.providers.openai.temperature": "number",
  "ai.providers.anthropic.temperature": "number",
  "ai.providers.google.temperature": "number",
  "ai.providers.cohere.temperature": "number",
  "ai.providers.mistral.temperature": "number",

  // Booleans
  "logger.enableAgentLogs": "boolean",
  "logger.includeTimestamp": "boolean",
  "logger.includeLevel": "boolean",
  "logger.includeSource": "boolean",
  "ai.providers.openai.enabled": "boolean",
  "ai.providers.anthropic.enabled": "boolean",
  "ai.providers.google.enabled": "boolean",
  "ai.providers.cohere.enabled": "boolean",
  "ai.providers.mistral.enabled": "boolean",

  // JSON (arrays and objects)
  detectionRules: "json",
  "ai.providers.openai.models": "json",
  "ai.providers.anthropic.models": "json",
  "ai.providers.google.models": "json",
  "ai.providers.cohere.models": "json",
  "ai.providers.mistral.models": "json",
  "ai.providers.openai.headers": "json",
  "ai.providers.anthropic.headers": "json",
  "ai.providers.google.headers": "json",
  "ai.providers.cohere.headers": "json",
  "ai.providers.mistral.headers": "json",
} as const;

/**
 * Load configuration from environment variables
 */
export function loadEnvironmentConfiguration(): PartialConfiguration {
  const config: any = {};

  // Process explicit mappings
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      setConfigValue(config, configPath, value);
    }
  }

  // Process MINSKY_ prefixed variables (automatic mapping)
  for (const [envVar, value] of Object.entries(process.env)) {
    if (envVar.startsWith("MINSKY_") && value !== undefined) {
      // Skip if already handled by explicit mapping
      if (envVar in environmentMappings) continue;

      // Convert MINSKY_PREFIX to config path
      const configPath = envVarToConfigPath(envVar);
      if (configPath) {
        setConfigValue(config, configPath, value);
      }
    }
  }

  return config;
}

/**
 * Convert environment variable name to configuration path
 */
function envVarToConfigPath(envVar: string): string | null {
  // Remove MINSKY_ prefix
  const withoutPrefix = envVar.replace(/^MINSKY_/, "");

  // Convert SCREAMING_SNAKE_CASE to dot.notation.path
  const parts = withoutPrefix.toLowerCase().split("_");

  // Handle known patterns
  if (parts[0] === "ai" && parts[1] === "providers" && parts.length >= 3) {
    // AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.apiKey
    const provider = parts[2]!;
    const field = parts.slice(3).join("_");
    return `ai.providers.${provider}.${camelCase(field)}`;
  }

  if (parts[0] === "sessiondb") {
    // SESSIONDB_BACKEND -> sessiondb.backend
    // SESSIONDB_SQLITE_PATH -> sessiondb.sqlite.path
    if (parts.length === 2) {
      return `sessiondb.${camelCase(parts[1]!)}`;
    } else if (parts.length === 3) {
      return `sessiondb.${parts[1]}.${camelCase(parts[2]!)}`;
    }
  }

  if (parts[0] === "workspace") {
    // WORKSPACE_MAIN_PATH -> workspace.mainPath
    if (parts[1] === "main" && parts[2] === "path") {
      return "workspace.mainPath";
    }
  }

  if (parts[0] === "logger" || parts[0] === "log") {
    // LOGGER_MODE -> logger.mode
    // LOG_LEVEL -> logger.level
    const field = parts.slice(1).join("_");
    return `logger.${camelCase(field)}`;
  }

  // Default: convert to camelCase path
  return parts.map(camelCase).join(".");
}

/**
 * Convert snake_case to camelCase
 */
function camelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Set a nested configuration value using dot notation path
 */
function setConfigValue(config: any, path: string, value: string): void {
  const parts = path.split(".");
  let current = config;

  // Navigate to the parent object
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }

  // Set the final value with type conversion
  const finalKey = parts[parts.length - 1]!;
  const fieldType = fieldTypes[path] || "string";
  const convertedValue = typeConverters[fieldType](value);

  current[finalKey] = convertedValue;
}

/**
 * Get environment configuration with metadata
 */
export function getEnvironmentConfiguration(): {
  config: PartialConfiguration;
  metadata: {
    loadedVariables: string[];
    mappings: Record<string, string>;
  };
} {
  const loadedVariables: string[] = [];
  const mappings: Record<string, string> = {};

  // Track which environment variables were loaded
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    if (process.env[envVar] !== undefined) {
      loadedVariables.push(envVar);
      mappings[envVar] = configPath;
    }
  }

  // Track MINSKY_ prefixed variables
  for (const envVar of Object.keys(process.env)) {
    if (envVar.startsWith("MINSKY_") && !(envVar in environmentMappings)) {
      const configPath = envVarToConfigPath(envVar);
      if (configPath && process.env[envVar] !== undefined) {
        loadedVariables.push(envVar);
        mappings[envVar] = configPath;
      }
    }
  }

  return {
    config: loadEnvironmentConfiguration(),
    metadata: {
      loadedVariables,
      mappings,
    },
  };
}

/**
 * Configuration source metadata
 */
export const environmentSourceMetadata = {
  name: "environment",
  description: "Environment variables configuration",
  priority: 100, // Highest priority
  required: false,
} as const;
