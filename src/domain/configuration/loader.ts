/**
 * Configuration Loader
 *
 * Main orchestrator for loading and merging configuration from multiple sources
 * with proper hierarchical precedence and validation.
 */

import { z } from "zod";
import type { Configuration, PartialConfiguration, ConfigurationValidationResult } from "./schemas";
import { configurationSchema } from "./schemas";
import { getDefaultConfiguration, defaultsSourceMetadata } from "./sources/defaults";
import { getProjectConfiguration, projectSourceMetadata } from "./sources/project";
import { getUserConfiguration, userSourceMetadata } from "./sources/user";
import { getEnvironmentConfiguration, environmentSourceMetadata } from "./sources/environment";
import { log } from "../../utils/logger";
import { deepMergeConfigs } from "./deep-merge";

/**
 * Typed marker for schema-validation failures at config-load time. The CLI
 * boundary catch recognizes this class precisely (instanceof check) and
 * renders a clean one-line diagnostic plus remediation hint instead of the
 * default Winston cascade of log.error → uncaughtException dump.
 *
 * The wrapped message is the raw "Configuration validation failed: <detail>"
 * produced by validateConfiguration — preserving the unrecognized-key name
 * and field path that the operator needs to fix the config file.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

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
  readonly metadata: Record<string, unknown>;
  readonly loadedAt: Date;
  readonly success: boolean;
  readonly error?: Error;
}

/**
 * Value source tracking for individual configuration values
 */
export interface ValueSourceMap {
  [key: string]: string | ValueSourceMap;
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
      value: unknown;
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

      // Build effective values for provenance tracking (consumed by callers via the load result)
      const effectiveValues = this.buildEffectiveValues(sourceResults);

      // Validate final configuration against the strict schema
      const validationResult = this.options.skipValidation
        ? { success: true, data: mergedConfig as Configuration }
        : this.validateConfiguration(mergedConfig);

      // Handle validation errors
      if (!validationResult.success && this.options.failOnValidationError) {
        const errorMessage = validationResult.error
          ? this.extractValidationErrors(validationResult.error).join(", ")
          : "Unknown validation error";
        // Throw the typed marker directly — avoids the brittle message-prefix
        // check at the outer catch (PR #1090 R1 NB#2).
        throw new ConfigValidationError(`Configuration validation failed: ${errorMessage}`);
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
        effectiveValues,
      };

      // Cache result
      if (this.options.enableCache) {
        this.cachedResult = result;
        this.lastLoadTime = startTime;
      }

      return result;
    } catch (error) {
      // ConfigValidationError is thrown directly by the validator block above;
      // let it propagate so the CLI boundary catch can recognize it via
      // instanceof. Other failure modes (file-read errors, malformed YAML,
      // etc.) get the generic "Configuration loading failed:" prefix.
      if (error instanceof ConfigValidationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Configuration loading failed: ${message}`);
    }
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
          log.debug(`✓ Loaded ${source.metadata.name} configuration`);
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
          log.warn(`⚠ Failed to load ${source.metadata.name} configuration: ${errorObj.message}`);
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

    let mergedConfig: Record<string, unknown> = {};

    for (const sourceResult of sortedSources) {
      mergedConfig = deepMergeConfigs(mergedConfig, sourceResult.config as Record<string, unknown>);

      if (this.options.logDebugInfo) {
        log.debug(
          `📥 Merged ${sourceResult.source.name} (priority: ${sourceResult.source.priority})`
        );
      }
    }

    return mergedConfig as PartialConfiguration;
  }

  /**
   * Validate merged configuration against the strict top-level schema.
   *
   * Unknown top-level keys produce a ZodError with `unrecognized_keys` —
   * caught here so typos and stale legacy keys fail loudly at load time
   * instead of being silently stripped or passed through.
   */
  private validateConfiguration(config: PartialConfiguration): ConfigurationValidationResult {
    const result = configurationSchema.safeParse(config);

    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error,
      issues: result.error.issues,
    };
  }

  /**
   * Extract readable validation errors from Zod error
   */
  private extractValidationErrors(error: z.ZodError): string[] {
    if (!error.issues || !Array.isArray(error.issues)) {
      return [error.message || String(error)];
    }

    return error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    });
  }

  /**
   * Build effective values map showing which source provided each value
   */
  private buildEffectiveValues(sourceResults: ConfigurationSourceResult[]): Record<
    string,
    {
      value: unknown;
      source: string;
      path: string;
    }
  > {
    const effectiveValues: Record<string, { value: unknown; source: string; path: string }> = {};

    // Sort by priority to track which source wins for each value
    const sortedSources = sourceResults
      .filter((result) => result.success)
      .sort((a, b) => a.source.priority - b.source.priority);

    for (const sourceResult of sortedSources) {
      this.collectConfigPaths(
        sourceResult.config as Record<string, unknown>,
        sourceResult.source.name,
        "",
        effectiveValues
      );
    }

    return effectiveValues;
  }

  /**
   * Recursively collect configuration paths for tracking
   * Uses Record<string, unknown> for deep config traversal across arbitrary nesting levels
   */
  private collectConfigPaths(
    config: Record<string, unknown>,
    sourceName: string,
    currentPath: string,
    collector: Record<string, { value: unknown; source: string; path: string }>
  ): void {
    if (config === null || config === undefined || typeof config !== "object") {
      return;
    }

    for (const key in config) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        const fullPath = currentPath ? `${currentPath}.${key}` : key;
        const value = config[key];

        // Skip undefined values to avoid showing empty defaults
        if (value === undefined) {
          continue;
        }

        // For objects, recurse first to get leaf values
        if (typeof value === "object" && !Array.isArray(value) && value !== null) {
          this.collectConfigPaths(
            value as Record<string, unknown>,
            sourceName,
            fullPath,
            collector
          );
        } else {
          // Only store leaf values (non-objects), later sources will override earlier ones
          collector[fullPath] = {
            value,
            source: sourceName,
            path: fullPath,
          };
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
