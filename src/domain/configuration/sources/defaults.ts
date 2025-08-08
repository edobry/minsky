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
    // Note: github-issues config omitted - will be undefined by default
  },

  detectionRules: [
    { condition: "tasks_md_exists", backend: "markdown" },
    { condition: "json_file_exists", backend: "json-file" },
    { condition: "always", backend: "markdown" },
  ],

  // Session database configuration
  sessiondb: {
    backend: "sqlite",
    sqlite: {
      // Note: path and baseDir omitted - will use XDG defaults at runtime
    },
    // Note: postgres config omitted - only set when actually configured
  },

  // GitHub configuration
  // Note: All fields omitted - will be undefined by default
  // Users must explicitly configure GitHub settings

  // AI providers configuration
  ai: {
    // Note: defaultProvider omitted - will auto-detect from available providers
    providers: {
      openai: {
        enabled: true,
        model: "gpt-4",
        models: [],
        // Note: apiKey, baseUrl, etc. omitted - set via environment or user config
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

  // Logger configuration
  logger: {
    mode: "auto",
    level: "info",
    enableAgentLogs: false,
    includeTimestamp: true,
    includeLevel: true,
    includeSource: false,
    maxFileSize: 100,
    maxFiles: 5,
    // Note: logFile omitted - will use default or user-specified location
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
