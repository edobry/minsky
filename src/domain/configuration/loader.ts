/**
 * Configuration Loader
 *
 * Main orchestrator for loading and merging configuration from multiple sources
 * with proper hierarchical precedence and validation.
 */

import type { Configuration, PartialConfiguration, ConfigurationValidationResult } from "./schemas";
import { configurationSchema } from "./schemas";
import { getDefaultConfiguration, defaultsSourceMetadata } from "./sources/defaults";
import { getProjectConfiguration, projectSourceMetadata } from "./sources/project";
import { getUserConfiguration, userSourceMetadata } from "./sources/user";
import { getEnvironmentConfiguration, environmentSourceMetadata } from "./sources/environment";

/**
 * Configuration source metadata
 */
export interface ConfigurationSourceMetadata {
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly required: boolean;
}

/**
 * Configuration loading result from a single source
 */
export interface ConfigurationSourceResult {
  readonly source: ConfigurationSourceMetadata;
  readonly config: PartialConfiguration;
  readonly metadata: Record<string, any>;
  readonly loadedAt: Date;
  readonly success: boolean;
  readonly error?: Error;
}

/**
 * Complete configuration loading result
 */
export interface ConfigurationLoadResult {
  readonly config: Configuration;
  readonly sources: ConfigurationSourceResult[];
  readonly validationResult: ConfigurationValidationResult;
  readonly loadedAt: Date;
  readonly mergeOrder: string[];
  readonly effectiveValues: Record<
    string,
    {
      value: any;
      source: string;
      path: string;
    }
  >;
}

/**
 * Configuration loader options
 */
export interface ConfigurationLoaderOptions {
  readonly workingDirectory?: string;
  readonly skipValidation?: boolean;
  readonly enableCache?: boolean;
  readonly logDebugInfo?: boolean;
  readonly failOnValidationError?: boolean;
  readonly sourcesToLoad?: string[];
}

/**
 * Configuration loader class
 */
export class ConfigurationLoader {
  private cachedResult: ConfigurationLoadResult | null = null;
  private lastLoadTime: Date | null = null;
  private readonly options: Required<ConfigurationLoaderOptions>;

  constructor(options: ConfigurationLoaderOptions = {}) {
    this.options = {
      workingDirectory: process.cwd(),
      skipValidation: false,
      enableCache: true,
      logDebugInfo: false,
      failOnValidationError: true,
      sourcesToLoad: ["defaults", "project", "user", "environment"],
      ...options,
    };
  }

  /**
   * Load configuration from all sources
   */
  async load(): Promise<ConfigurationLoadResult> {
    const startTime = new Date();

    // Check cache
    if (this.options.enableCache && this.cachedResult) {
      return this.cachedResult;
    }

    try {
      // Load from all sources
      const sourceResults = await this.loadAllSources();

      // Merge configurations with proper precedence
      const mergedConfig = this.mergeConfigurations(sourceResults);

      // Validate final configuration
      const validationResult = this.options.skipValidation
        ? { success: true, data: mergedConfig as Configuration }
        : this.validateConfiguration(mergedConfig);

      // Handle validation errors
      if (!validationResult.success && this.options.failOnValidationError) {
        const errorMessage = validationResult.error
          ? this.extractValidationErrors(validationResult.error).join(", ")
          : "Unknown validation error";
        throw new Error(`Configuration validation failed: ${errorMessage}`);
      }

      // Build result
      const result: ConfigurationLoadResult = {
        config: validationResult.data || (mergedConfig as Configuration),
        sources: sourceResults,
        validationResult,
        loadedAt: startTime,
        mergeOrder: sourceResults
          .filter((r) => r.success)
          .sort((a, b) => a.source.priority - b.source.priority)
          .map((r) => r.source.name),
        effectiveValues: this.buildEffectiveValues(sourceResults),
      };

      // Cache result
      if (this.options.enableCache) {
        this.cachedResult = result;
        this.lastLoadTime = startTime;
      }

      return result;
    } catch (error) {
      throw new Error(
        `Configuration loading failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Reload configuration (clears cache)
   */
  async reload(): Promise<ConfigurationLoadResult> {
    this.clearCache();
    return this.load();
  }

  /**
   * Clear configuration cache
   */
  clearCache(): void {
    this.cachedResult = null;
    this.lastLoadTime = null;
  }

  /**
   * Get cached configuration result
   */
  getCached(): ConfigurationLoadResult | null {
    return this.cachedResult;
  }

  /**
   * Load configuration from all sources
   */
  private async loadAllSources(): Promise<ConfigurationSourceResult[]> {
    const sources = [
      {
        metadata: defaultsSourceMetadata,
        loader: () => ({ config: getDefaultConfiguration(), metadata: {} }),
      },
      {
        metadata: projectSourceMetadata,
        loader: () => getProjectConfiguration(this.options.workingDirectory),
      },
      {
        metadata: userSourceMetadata,
        loader: () => getUserConfiguration(),
      },
      {
        metadata: environmentSourceMetadata,
        loader: () => getEnvironmentConfiguration(),
      },
    ];

    const results: ConfigurationSourceResult[] = [];
    const loadedAt = new Date();

    for (const source of sources) {
      // Skip if not in sources to load
      if (!this.options.sourcesToLoad.includes(source.metadata.name)) {
        continue;
      }

      try {
        const result = source.loader();
        results.push({
          source: source.metadata,
          config: result.config,
          metadata: result.metadata,
          loadedAt,
          success: true,
        });

        if (this.options.logDebugInfo) {
          console.log(`✓ Loaded ${source.metadata.name} configuration`);
        }
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));

        results.push({
          source: source.metadata,
          config: {} as PartialConfiguration,
          metadata: {},
          loadedAt,
          success: false,
          error: errorObj,
        });

        // Required sources must load successfully
        if (source.metadata.required) {
          throw new Error(
            `Required configuration source '${source.metadata.name}' failed to load: ${errorObj.message}`
          );
        }

        if (this.options.logDebugInfo) {
          console.warn(
            `⚠ Failed to load ${source.metadata.name} configuration: ${errorObj.message}`
          );
        }
      }
    }

    return results;
  }

  /**
   * Merge configurations with hierarchical precedence
   */
  private mergeConfigurations(sourceResults: ConfigurationSourceResult[]): PartialConfiguration {
    // Sort by priority (lower priority = loaded first, higher priority overrides)
    const sortedSources = sourceResults
      .filter((result) => result.success)
      .sort((a, b) => a.source.priority - b.source.priority);

    let mergedConfig: PartialConfiguration = {} as PartialConfiguration;

    for (const sourceResult of sortedSources) {
      mergedConfig = this.deepMerge(mergedConfig, sourceResult.config);

      if (this.options.logDebugInfo) {
        console.log(
          `📥 Merged ${sourceResult.source.name} (priority: ${sourceResult.source.priority})`
        );
      }
    }

    return mergedConfig;
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

  /**
   * Validate merged configuration
   */
  private validateConfiguration(config: PartialConfiguration): ConfigurationValidationResult {
    const result = configurationSchema.safeParse(config);

    if (result.success) {
      return {
        success: true,
        data: result.data,
      };
    } else {
      // Filter out "unrecognized key" errors and turn them into warnings
      const criticalIssues = result.error.issues.filter(issue => 
        !(issue.code === 'unrecognized_keys' || 
          (issue.message && issue.message.includes('Unrecognized key')))
      );

      // If only unrecognized key errors, treat as success with warnings
      if (criticalIssues.length === 0) {
        // Log warnings for unrecognized keys
        const warnings = result.error.issues.map(issue => {
          const path = issue.path?.length > 0 ? issue.path.join('.') : 'root';
          return `Warning: Unknown configuration field at ${path}: ${issue.message}`;
        });
        
        // Print warnings to stderr
        warnings.forEach(warning => console.warn(warning));

        // Return success with the original config data (typed as Configuration)
        return {
          success: true,
          data: config as any, // We know it's valid except for unknown keys
        };
      }

      return {
        success: false,
        error: result.error,
        issues: criticalIssues,
      };
    }
  }

  /**
   * Extract readable validation errors from Zod error
   */
  private extractValidationErrors(error: any): string[] {
    if (!error.errors || !Array.isArray(error.errors)) {
      return [error.message || String(error)];
    }

    return error.errors.map((err: any) => {
      const path = err.path?.length > 0 ? err.path.join(".") : "root";
      return `${path}: ${err.message}`;
    });
  }

  /**
   * Build effective values map showing which source provided each value
   */
  private buildEffectiveValues(sourceResults: ConfigurationSourceResult[]): Record<
    string,
    {
      value: any;
      source: string;
      path: string;
    }
  > {
    const effectiveValues: Record<string, { value: any; source: string; path: string }> = {};

    // Sort by priority to track which source wins for each value
    const sortedSources = sourceResults
      .filter((result) => result.success)
      .sort((a, b) => a.source.priority - b.source.priority);

    for (const sourceResult of sortedSources) {
      this.collectConfigPaths(sourceResult.config, sourceResult.source.name, "", effectiveValues);
    }

    return effectiveValues;
  }

  /**
   * Recursively collect configuration paths for tracking
   */
  private collectConfigPaths(
    config: any,
    sourceName: string,
    currentPath: string,
    collector: Record<string, { value: any; source: string; path: string }>
  ): void {
    if (config === null || config === undefined || typeof config !== "object") {
      return;
    }

    for (const key in config) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        const fullPath = currentPath ? `${currentPath}.${key}` : key;
        const value = config[key];

        // Store the value (later sources will override earlier ones)
        collector[fullPath] = {
          value,
          source: sourceName,
          path: fullPath,
        };

        // Recurse for nested objects
        if (typeof value === "object" && !Array.isArray(value) && value !== null) {
          this.collectConfigPaths(value, sourceName, fullPath, collector);
        }
      }
    }
  }
}

/**
 * Default configuration loader instance
 */
export const defaultLoader = new ConfigurationLoader();

/**
 * Load configuration using default loader
 */
export async function loadConfiguration(
  options?: ConfigurationLoaderOptions
): Promise<ConfigurationLoadResult> {
  if (options) {
    const loader = new ConfigurationLoader(options);
    return loader.load();
  }

  return defaultLoader.load();
}

/**
 * Reload configuration using default loader
 */
export async function reloadConfiguration(): Promise<ConfigurationLoadResult> {
  return defaultLoader.reload();
}

/**
 * Get cached configuration result
 */
export function getCachedConfiguration(): ConfigurationLoadResult | null {
  return defaultLoader.getCached();
}

/**
 * Clear configuration cache
 */
export function clearConfigurationCache(): void {
  defaultLoader.clearCache();
}
