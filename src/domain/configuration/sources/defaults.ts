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
  // Backend configuration
  backend: "markdown",

  backendConfig: {
    markdown: {},
    "json-file": {},
  },

  // Backend detection rules are now hardcoded in BackendDetectionService

  sessiondb: {
    backend: "sqlite",
    sqlite: {},
  },

  ai: {
    providers: {
      openai: {
        enabled: true,
        model: "gpt-4",
        models: [],
      },
      anthropic: {
        enabled: true,
        model: "claude-3-sonnet-20240229",
        models: [],
      },
      google: {
        enabled: true,
        model: "gemini-pro",
        models: [],
      },
      cohere: {
        enabled: true,
        model: "command",
        models: [],
      },
      mistral: {
        enabled: true,
        model: "mistral-medium",
        models: [],
      },
    },
  },

  logger: {
    mode: "auto",
    level: "info",
    enableAgentLogs: false,
    includeTimestamp: true,
    includeLevel: true,
    includeSource: false,
    maxFileSize: 100,
    maxFiles: 5,
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
