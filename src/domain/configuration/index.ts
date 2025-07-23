/**
 * Configuration System Public API
 *
 * Provides a unified interface for configuration access that can be backed
 * by either node-config (legacy) or the new custom configuration system.
 * This allows for gradual migration while maintaining behavioral compatibility.
 */

import type { Configuration, PartialConfiguration } from "./schemas";
export type { Configuration, PartialConfiguration } from "./schemas";
export { configurationSchema } from "./schemas";

/**
 * Configuration provider interface
 *
 * This interface abstracts over different configuration implementations,
 * allowing tests to target the interface rather than specific implementations.
 */
export interface ConfigurationProvider {
  /**
   * Get the complete configuration object
   */
  getConfig(): Configuration;

  /**
   * Get a configuration value by path
   */
  get<T = any>(path: string): T;

  /**
   * Check if a configuration path exists
   */
  has(path: string): boolean;

  /**
   * Reload configuration from sources
   */
  reload(): Promise<void>;

  /**
   * Get configuration source information for debugging
   */
  getMetadata(): ConfigurationMetadata;

  /**
   * Validate current configuration
   */
  validate(): ValidationResult;
}

/**
 * Configuration metadata for debugging and introspection
 */
export interface ConfigurationMetadata {
  sources: Array<{
    name: string;
    priority: number;
    loaded: boolean;
    path?: string;
    error?: string;
  }>;
  loadedAt: Date;
  version: string;
}

/**
 * Configuration validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    severity: "error" | "warning" | "info";
  }>;
}

/**
 * Configuration override options for testing
 */
export interface ConfigurationOverrides {
  [key: string]: any;
}

/**
 * Configuration factory for creating providers
 */
export interface ConfigurationFactory {
  /**
   * Create a configuration provider
   */
  createProvider(options?: {
    workingDirectory?: string;
    overrides?: ConfigurationOverrides;
    skipValidation?: boolean;
    enableCache?: boolean;
  }): Promise<ConfigurationProvider>;
}

// NodeConfigProvider removed - node-config has been fully replaced by custom configuration system

/**
 * Custom configuration provider implementing the ConfigurationProvider interface
 *
 * This is the new implementation using our custom configuration system.
 */
export class CustomConfigurationProvider implements ConfigurationProvider {
  private configResult: any | null = null;
  private readonly options: any;

  constructor(options: any = {}) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    const { loadConfiguration } = await import("./loader");
    try {
      this.configResult = await loadConfiguration(this.options);
      // Validate that we got a proper result
      if (!this.configResult || !this.configResult.sources) {
        throw new Error(`Invalid configuration result: ${JSON.stringify(this.configResult)}`);
      }
    } catch (error) {
      console.error("Configuration loading failed:", error);
      throw error;
    }
  }

  getConfig(): Configuration {
    if (!this.configResult) {
      throw new Error("Configuration not loaded. Call initialize() first.");
    }
    return this.configResult.config;
  }

  get<T = any>(path: string): T {
    const config = this.getConfig();
    const value = this.getNestedValue(config, path);

    if (value === undefined) {
      throw new Error(`Configuration path '${path}' not found`);
    }

    return value as T;
  }

  has(path: string): boolean {
    try {
      const config = this.getConfig();
      return this.getNestedValue(config, path) !== undefined;
    } catch {
      return false;
    }
  }

  async reload(): Promise<void> {
    // Clear the current config and reload from sources
    this.configResult = null;
    try {
      await this.initialize();
    } catch (error) {
      // If initialization fails, log but don't throw
      console.warn("Warning: CustomConfigurationProvider reload had issues:", error);
    }
    // Explicit return to ensure promise resolves
    return Promise.resolve();
  }

  getMetadata(): ConfigurationMetadata {
    if (!this.configResult) {
      throw new Error("Configuration not loaded. Call initialize() first.");
    }

    return {
      sources: this.configResult.sources.map((source: any) => ({
        name: source.source.name,
        priority: source.source.priority,
        loaded: source.success,
        path: source.metadata?.configFile,
        error: source.error?.message,
      })),
      loadedAt: this.configResult.loadedAt,
      version: "custom",
    };
  }

  validate(): ValidationResult {
    if (!this.configResult) {
      return {
        valid: false,
        errors: [
          {
            path: "root",
            message: "Configuration not loaded",
            severity: "error",
          },
        ],
      };
    }

    return {
      valid: this.configResult.validationResult.success,
      errors:
        this.configResult.validationResult.issues?.map((issue: any) => ({
          path: issue.path?.join?.(".") || "unknown",
          message: issue.message,
          severity: "error" as const,
        })) || [],
    };
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => {
      return current?.[key];
    }, obj);
  }
}

/**
 * Configuration factory implementation
 */
export class CustomConfigFactory implements ConfigurationFactory {
  async createProvider(options?: {
    workingDirectory?: string;
    overrides?: ConfigurationOverrides;
    skipValidation?: boolean;
    enableCache?: boolean;
  }): Promise<ConfigurationProvider> {
    const provider = new CustomConfigurationProvider({
      workingDirectory: options?.workingDirectory,
      skipValidation: options?.skipValidation,
      enableCache: options?.enableCache,
      // Apply overrides by adding them as a high-priority source
      ...(options?.overrides && {
        sourcesToLoad: ["defaults", "project", "user", "environment", "overrides"],
        overrideSource: options.overrides,
      }),
    });

    await provider.initialize();
    return provider;
  }
}

/**
 * Global configuration instance
 *
 * This is the main configuration object that the application should use.
 * It can be switched between implementations for migration.
 */
let globalProvider: ConfigurationProvider | null = null;
let globalFactory: ConfigurationFactory | null = null;

/**
 * Initialize the configuration system
 *
 * @param factory - Factory to create the configuration provider
 * @param options - Options for provider creation
 */
export async function initializeConfiguration(
  factory: ConfigurationFactory,
  options?: {
    workingDirectory?: string;
    overrides?: ConfigurationOverrides;
    skipValidation?: boolean;
    enableCache?: boolean;
  }
): Promise<void> {
  globalFactory = factory;
  globalProvider = await factory.createProvider(options);
}

/**
 * Get the current configuration
 *
 * This function returns the currently loaded configuration. If no configuration
 * has been loaded yet, it will attempt to load it automatically.
 */
export function getConfiguration(): Configuration {
  if (!globalProvider) {
    // Auto-initialize with default factory if not already initialized
    const { CustomConfigFactory } = require("./index");
    const factory = new CustomConfigFactory();

    // This is a synchronous function, so we can't await here
    // Instead, we'll create a provider synchronously and cache it
    if (!globalProvider) {
      // For backward compatibility, create a simple provider that loads config
      // This will be replaced with proper async initialization in the future
      try {
        const { loadConfiguration } = require("./loader");
        const result = loadConfiguration({ workingDirectory: process.cwd() });

        if (result && typeof result.then === "function") {
          // If it's a promise, we can't handle it synchronously
          throw new Error(
            "Configuration must be initialized asynchronously. Call initializeConfiguration() first."
          );
        }

        // Create a simple provider with the loaded config
        globalProvider = {
          getConfig: () => result.config,
          get: function <T>(path: string): T {
            const config = this.getConfig();
            return path.split(".").reduce((current, key) => current?.[key], config) as T;
          },
          has: function (path: string): boolean {
            try {
              const config = this.getConfig();
              return path.split(".").reduce((current, key) => current?.[key], config) !== undefined;
            } catch {
              return false;
            }
          },
          reload: async () => {},
          getMetadata: () => ({ sources: [], loadedAt: new Date(), version: "fallback" }),
          validate: () => ({ valid: true, errors: [] }),
        };
      } catch (error) {
        // Fallback to empty configuration
        const emptyConfig = {
          backend: "markdown" as const,
          backendConfig: {},
          detectionRules: [],
          sessiondb: { backend: "sqlite" as const },
          github: {},
          ai: {},
          logger: { mode: "auto" as const, level: "info" as const },
          workflows: {},
        };

        globalProvider = {
          getConfig: () => emptyConfig,
          get: function <T>(path: string): T {
            return path.split(".").reduce((current, key) => current?.[key], emptyConfig) as T;
          },
          has: function (path: string): boolean {
            return (
              path.split(".").reduce((current, key) => current?.[key], emptyConfig) !== undefined
            );
          },
          reload: async () => {},
          getMetadata: () => ({ sources: [], loadedAt: new Date(), version: "fallback" }),
          validate: () => ({ valid: true, errors: [] }),
        };
      }
    }
  }

  return globalProvider!.getConfig();
}

// Convenience exports for common configuration sections
export const config = {
  /**
   * Get the full configuration object (lazy-loaded)
   */
  get all(): Configuration {
    return getConfiguration();
  },

  /**
   * Get backend configuration
   */
  get backend() {
    return getConfiguration().backend;
  },

  /**
   * Get backend-specific configuration
   */
  get backendConfig() {
    return getConfiguration().backendConfig;
  },

  /**
   * Get session database configuration
   */
  get sessiondb() {
    return getConfiguration().sessiondb;
  },

  /**
   * Get GitHub configuration
   */
  get github() {
    return getConfiguration().github;
  },

  /**
   * Get AI configuration
   */
  get ai() {
    return getConfiguration().ai;
  },

  /**
   * Get logger configuration
   */
  get logger() {
    return getConfiguration().logger;
  },

  /**
   * Get workflow commands configuration
   */
  get workflows() {
    return getConfiguration().workflows;
  },
} as const;

/**
 * Legacy compatibility - direct configuration object access
 *
 * This provides backward compatibility with existing code that expects
 * a direct configuration object rather than going through the provider.
 *
 * @deprecated Use the provider interface or config object instead
 */
export const legacyConfig = new Proxy({} as Configuration, {
  get(_target, prop: string) {
    if (typeof prop === "string") {
      try {
        return getConfiguration()[prop as keyof Configuration];
      } catch {
        return undefined;
      }
    }
    return undefined;
  },

  has(_target, prop: string) {
    if (typeof prop === "string") {
      try {
        return prop in getConfiguration();
      } catch {
        return false;
      }
    }
    return false;
  },
});

// Default exports for easy importing
export default config;
