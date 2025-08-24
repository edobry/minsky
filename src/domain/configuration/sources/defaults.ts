/**
 * Default Configuration Values
 *
 * Provides the base configuration values that serve as defaults for the entire
 * application. These values are used when no override is provided in project
 * configuration, user configuration, or environment variables.
 */

import type { PartialConfiguration } from "../schemas";

/**
 * Application default configuration
 *
 * These are the baseline configuration values that the application uses
 * when no other configuration source provides a value.
 */
export const defaultConfiguration: PartialConfiguration = {
  // Backend configuration (deprecated - only include if explicitly set)
  // backend: removed default value since this property is deprecated

  backendConfig: {
    "github-issues": undefined,
    markdown: {},
    "json-file": {},
  },



  // Session database configuration
  sessiondb: {
    backend: "sqlite",
    sqlite: {
      path: undefined, // Will use default location
      baseDir: undefined, // Will use XDG standard
    },
    postgres: undefined,
  },

  // GitHub configuration (all optional)
  github: {
    tokenFile: undefined,
    organization: undefined,
    repository: undefined,
    baseUrl: undefined,
  },

  // AI providers configuration
  ai: {
    defaultProvider: undefined, // Auto-detect from available providers
    providers: {
      openai: {
        apiKey: undefined,
        apiKeyFile: undefined,
        enabled: true,
        model: "gpt-4",
        models: [],
        baseUrl: undefined,
        maxTokens: undefined,
        temperature: undefined,
        headers: undefined,
      },
      anthropic: {
        apiKey: undefined,
        apiKeyFile: undefined,
        enabled: true,
        model: "claude-3-sonnet-20240229",
        models: [],
        baseUrl: undefined,
        maxTokens: undefined,
        temperature: undefined,
        headers: undefined,
      },
      google: {
        apiKey: undefined,
        apiKeyFile: undefined,
        enabled: true,
        model: "gemini-pro",
        models: [],
        baseUrl: undefined,
        maxTokens: undefined,
        temperature: undefined,
        headers: undefined,
        projectId: undefined,
      },
      cohere: {
        apiKey: undefined,
        apiKeyFile: undefined,
        enabled: true,
        model: "command",
        models: [],
        baseUrl: undefined,
        maxTokens: undefined,
        temperature: undefined,
        headers: undefined,
      },
      mistral: {
        apiKey: undefined,
        apiKeyFile: undefined,
        enabled: true,
        model: "mistral-medium",
        models: [],
        baseUrl: undefined,
        maxTokens: undefined,
        temperature: undefined,
        headers: undefined,
      },
    },
  },

  // Embeddings configuration defaults
  embeddings: {
    provider: "openai",
    model: "text-embedding-3-small",
    normalize: false,
  },

  // Logger configuration
  logger: {
    mode: "auto",
    level: "info",
    enableAgentLogs: false,
    includeTimestamp: true,
    includeLevel: true,
    includeSource: false,
    logFile: undefined,
    maxFileSize: 100,
    maxFiles: 5,
  },

  // Tasks configuration
  tasks: {
    strictIds: false,
  },
};

/**
 * Get default configuration
 */
export function getDefaultConfiguration(): PartialConfiguration {
  return defaultConfiguration;
}

/**
 * Configuration source metadata
 */
export const defaultsSourceMetadata = {
  name: "defaults",
  description: "Application default configuration values",
  priority: 0, // Lowest priority
  required: true,
} as const;
