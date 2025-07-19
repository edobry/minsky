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

/**
 * Node-config adapter implementing the ConfigurationProvider interface
 * 
 * This allows existing node-config usage to continue working while
 * providing the same interface as the new custom system.
 */
export class NodeConfigProvider implements ConfigurationProvider {
  private nodeConfig: any;
  private cachedConfig: Configuration | null = null;

  constructor() {
    // Delay require to avoid early initialization
    this.nodeConfig = this.loadNodeConfig();
  }

  private loadNodeConfig(): any {
    try {
      return require("config");
    } catch (error) {
      throw new Error(`Failed to load node-config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getConfig(): Configuration {
    if (!this.cachedConfig) {
      // Convert node-config to our Configuration type
      this.cachedConfig = this.convertNodeConfigToConfiguration();
    }
    return this.cachedConfig;
  }

  get<T = any>(path: string): T {
    try {
      return this.nodeConfig.get(path) as T;
    } catch (error) {
      throw new Error(`Configuration path '${path}' not found: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  has(path: string): boolean {
    try {
      return this.nodeConfig.has(path);
    } catch {
      return false;
    }
  }

  async reload(): Promise<void> {
    // node-config doesn't support reloading, so we clear our cache
    this.cachedConfig = null;
    // Note: node-config has limitations with reloading, we do our best effort
    try {
      delete require.cache[require.resolve("config")];
      this.nodeConfig = this.loadNodeConfig();
    } catch (error) {
      // If we can't reload node-config, just clear our cache
      // This is a known limitation of node-config
    }
  }

  getMetadata(): ConfigurationMetadata {
    const sources = this.nodeConfig.util?.getConfigSources?.() || [];
    
    return {
      sources: sources.map((source: any, index: number) => ({
        name: source.name || `source-${index}`,
        priority: index, // node-config doesn't expose priority directly
        loaded: true,
        path: source.name,
      })),
      loadedAt: new Date(), // node-config doesn't track this
      version: "node-config",
    };
  }

  validate(): ValidationResult {
    try {
      const config = this.getConfig();
      // This will throw if validation fails
      return {
        valid: true,
        errors: [],
      };
    } catch (error) {
      return {
        valid: false,
        errors: [{
          path: "root",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        }],
      };
    }
  }

  private convertNodeConfigToConfiguration(): Configuration {
    // Convert the raw node-config object to our typed Configuration
    const rawConfig = this.nodeConfig.util?.toObject?.() || {};
    
    // Apply our schema to validate and transform
    try {
      const { configurationSchema } = require("./schemas");
      return configurationSchema.parse(rawConfig);
    } catch (error) {
      throw new Error(`node-config data does not match expected schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

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
    this.configResult = await loadConfiguration(this.options);
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
        errors: [{
          path: "root",
          message: "Configuration not loaded",
          severity: "error",
        }],
      };
    }

    return {
      valid: this.configResult.validationResult.success,
      errors: this.configResult.validationResult.issues?.map((issue: any) => ({
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
 * Configuration factory implementations
 */
export class NodeConfigFactory implements ConfigurationFactory {
  async createProvider(): Promise<ConfigurationProvider> {
    return new NodeConfigProvider();
  }
}

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
        overrideSource: options.overrides 
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
export type TestProviderType = "node-config" | "custom";

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
  const factory = providerType === "custom" ? new CustomConfigFactory() : new NodeConfigFactory();
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
