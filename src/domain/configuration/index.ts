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

      // Apply overrides if provided
      if (this.options.overrideSource) {
        this.configResult.config = this.deepMerge(
          this.configResult.config,
          this.options.overrideSource
        );
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

  /**
   * Deep merge two configuration objects
   */
  private deepMerge(target: any, source: any): any {
    if (source === null || source === undefined) {
      return target;
    }

    if (target === null || target === undefined) {
      return source;
    }

    // For arrays, replace entirely (no concatenation)
    if (Array.isArray(source)) {
      return [...source];
    }

    // For primitive values, override
    if (typeof source !== "object") {
      return source;
    }

    // For objects, merge recursively
    const result = { ...target };

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (
          typeof source[key] === "object" &&
          !Array.isArray(source[key]) &&
          source[key] !== null
        ) {
          result[key] = this.deepMerge(result[key], source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }

    return result;
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
 * Get the global configuration provider
 *
 * @throws Error if configuration hasn't been initialized
 */
export function getConfigurationProvider(): ConfigurationProvider {
  if (!globalProvider) {
    throw new Error("Configuration not initialized. Call initializeConfiguration() first.");
  }
  return globalProvider;
}

/**
 * Get the complete configuration object
 *
 * Convenience method for accessing the full configuration.
 */
export function getConfiguration(): Configuration {
  return getConfigurationProvider().getConfig();
}

/**
 * Get a configuration value by path
 *
 * @param path - Dot-separated path to the configuration value
 * @returns The configuration value
 * @throws Error if path doesn't exist
 */
export function get<T = any>(path: string): T {
  return getConfigurationProvider().get<T>(path);
}

/**
 * Check if a configuration path exists
 *
 * @param path - Dot-separated path to check
 * @returns true if the path exists
 */
export function has(path: string): boolean {
  return getConfigurationProvider().has(path);
}

/**
 * Reload configuration from sources
 *
 * @throws Error if configuration hasn't been initialized
 */
export async function reloadConfiguration(): Promise<void> {
  await getConfigurationProvider().reload();
}

/**
 * Get configuration metadata for debugging
 *
 * @returns Configuration metadata including source information
 */
export function getConfigurationMetadata(): ConfigurationMetadata {
  return getConfigurationProvider().getMetadata();
}

/**
 * Validate current configuration
 *
 * @returns Validation result with any errors
 */
export function validateConfiguration(): ValidationResult {
  return getConfigurationProvider().validate();
}

/**
 * Configuration provider type for testing
 */
export type TestProviderType = "custom";

/**
 * Create a configuration provider for testing
 *
 * @param overrides - Configuration overrides for testing
 * @param providerType - Which provider implementation to use
 * @returns A configuration provider with test overrides
 */
export async function createTestProvider(
  overrides: ConfigurationOverrides = {},
  providerType: TestProviderType = "custom"
): Promise<ConfigurationProvider> {
  const factory = new CustomConfigFactory();
  return factory.createProvider({
    overrides,
    skipValidation: false,
    enableCache: false,
  });
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
