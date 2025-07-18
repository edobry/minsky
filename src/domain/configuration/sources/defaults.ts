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
    "github-issues": undefined,
    markdown: {},
    "json-file": {},
  },
  
  detectionRules: [
    { condition: "tasks_md_exists", backend: "markdown" },
    { condition: "json_file_exists", backend: "json-file" },
    { condition: "always", backend: "markdown" },
  ],
  
  // Session database configuration
  sessiondb: {
    backend: "sqlite",
    json: {
      baseDir: undefined, // Will use XDG standard
    },
    sqlite: {
      path: undefined, // Will use default location
      baseDir: undefined, // Will use XDG standard
    },
    postgres: undefined,
  },
  
  // GitHub configuration (all optional)
  github: {
    token: undefined,
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
};

/**
 * Environment-specific default overrides
 * 
 * Provides different default values based on the runtime environment.
 */
export const environmentDefaults = {
  development: {
    logger: {
      mode: "HUMAN" as const,
      level: "debug" as const,
      enableAgentLogs: true,
      includeSource: true,
    },
  },
  
  production: {
    logger: {
      mode: "STRUCTURED" as const,
      level: "info" as const,
      enableAgentLogs: false,
      includeSource: false,
    },
  },
  
  test: {
    sessiondb: {
      backend: "json" as const, // Use JSON for faster tests
    },
    logger: {
      mode: "STRUCTURED" as const,
      level: "warn" as const,
      enableAgentLogs: false,
      includeSource: false,
    },
  },
  
  ci: {
    sessiondb: {
      backend: "json" as const,
    },
    logger: {
      mode: "STRUCTURED" as const,
      level: "info" as const,
      enableAgentLogs: false,
      includeSource: false,
    },
  },
} as const;

/**
 * Get default configuration for the current environment
 */
export function getDefaultConfiguration(): PartialConfiguration {
  const nodeEnv = process.env.NODE_ENV || "development";
  const envDefaults = environmentDefaults[nodeEnv as keyof typeof environmentDefaults] || {};
  
  return mergeDefaults(defaultConfiguration, envDefaults);
}

/**
 * Merge default configurations with environment-specific overrides
 */
function mergeDefaults(base: PartialConfiguration, override: Partial<PartialConfiguration>): PartialConfiguration {
  // Simple deep merge for configuration objects
  const result = { ...base };
  
  for (const key in override) {
    const sourceValue = override[key];
    const targetValue = result[key];
    
    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === "object" && 
        sourceValue !== null && 
        !Array.isArray(sourceValue) &&
        typeof targetValue === "object" && 
        targetValue !== null && 
        !Array.isArray(targetValue)
      ) {
        result[key] = { ...targetValue, ...sourceValue } as any;
      } else {
        result[key] = sourceValue as any;
      }
    }
  }
  
  return result;
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
