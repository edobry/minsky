/**
 * AI Model Cache Service
 *
 * Core implementation for caching AI provider model data with TTL management.
 * Handles local caching to ~/.cache/minsky/models/ with automatic refresh.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  ModelCacheService,
  CachedProviderModel,
  ModelCacheMetadata,
  ProviderCacheMetadata,
  ModelFetchConfig,
  CacheRefreshResult,
  CacheConfig,
  ModelCacheError,
  ModelFetcher,
} from "./types";
import { log } from "../../../utils/logger";

/**
 * Default cache configuration
 */
const DEFAULT_CACHE_CONFIG: CacheConfig = {
  cacheDir: join(homedir(), ".cache", "minsky", "models"),
  defaultTtl: 24 * 60 * 60 * 1000, // 24 hours
  requestTimeout: 30000, // 30 seconds
  autoRefresh: true,
  maxConcurrentRefresh: 3,
};

/**
 * Default model cache service implementation
 */
export class DefaultModelCacheService implements ModelCacheService {
  private config: CacheConfig;
  private fetchers: Map<string, ModelFetcher> = new Map();
  private refreshSemaphore: Map<string, Promise<void>> = new Map();

  constructor(config?: Partial<CacheConfig>) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /**
   * Register a model fetcher for a specific provider
   */
  registerFetcher(fetcher: ModelFetcher): void {
    this.fetchers.set(fetcher.provider, fetcher);
    log.debug(`Registered model fetcher for provider: ${fetcher.provider}`);
  }

  /**
   * Get cached models for a provider
   */
  async getCachedModels(provider: string): Promise<CachedProviderModel[]> {
    try {
      await this.ensureCacheDirectory();

      const cacheFilePath = this.getProviderCacheFile(provider);

      // Check if cache file exists
      try {
        await fs.access(cacheFilePath);
      } catch {
        log.debug(`No cache file found for provider: ${provider}`);
        return [];
      }

      // Read and parse cache file
      const cacheData = await fs.readFile(cacheFilePath, "utf-8");
      const models: CachedProviderModel[] = JSON.parse(cacheData.toString(), (key, value) => {
        // Parse dates during JSON deserialization
        if (key === "fetchedAt") {
          return new Date(value);
        }
        return value;
      });

      log.debug(`Loaded ${models.length} cached models for provider: ${provider}`);
      return models;
    } catch (error) {
      throw new ModelCacheError(
        `Failed to get cached models for provider ${provider}`,
        provider,
        "get_cached_models",
        "CACHE_READ_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Get all cached models for all providers
   */
  async getAllCachedModels(): Promise<Record<string, CachedProviderModel[]>> {
    try {
      await this.ensureCacheDirectory();

      const files = await fs.readdir(this.config.cacheDir);
      const modelFiles = files.filter(
        (file) => file.endsWith("-models.json") && !file.startsWith(".")
      );

      const allModels: Record<string, CachedProviderModel[]> = {};

      for (const file of modelFiles) {
        const provider = file.replace("-models.json", "");
        try {
          allModels[provider] = await this.getCachedModels(provider);
        } catch (error) {
          log.warn(`Failed to load cached models for provider ${provider}`, { error });
          allModels[provider] = [];
        }
      }

      return allModels;
    } catch (error) {
      throw new ModelCacheError(
        "Failed to get all cached models",
        "all",
        "get_all_cached_models",
        "CACHE_READ_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Refresh models for a specific provider
   */
  async refreshProvider(provider: string, config: ModelFetchConfig): Promise<void> {
    // Use semaphore to prevent concurrent refreshes of the same provider
    const existingRefresh = this.refreshSemaphore.get(provider);
    if (existingRefresh) {
      log.debug(`Waiting for existing refresh of provider: ${provider}`);
      await existingRefresh;
      return;
    }

    const refreshPromise = this.doRefreshProvider(provider, config);
    this.refreshSemaphore.set(provider, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this.refreshSemaphore.delete(provider);
    }
  }

  /**
   * Internal provider refresh implementation
   */
  private async doRefreshProvider(provider: string, config: ModelFetchConfig): Promise<void> {
    const startTime = Date.now();

    try {
      const fetcher = this.fetchers.get(provider);
      if (!fetcher) {
        throw new ModelCacheError(
          `No fetcher registered for provider: ${provider}`,
          provider,
          "refresh_provider",
          "NO_FETCHER",
          { availableFetchers: Array.from(this.fetchers.keys()) }
        );
      }

      log.debug(`Starting refresh for provider: ${provider}`);

      // Validate connection first
      const isConnected = await fetcher.validateConnection(config);
      if (!isConnected) {
        throw new ModelCacheError(
          `Failed to connect to provider: ${provider}`,
          provider,
          "refresh_provider",
          "CONNECTION_FAILED"
        );
      }

      // Fetch models
      const models = await fetcher.fetchModels(config);

      // Save to cache
      await this.saveProviderModels(provider, models);

      // Update metadata
      await this.updateProviderMetadata(provider, {
        lastFetched: new Date(),
        modelCount: models.length,
        lastFetchSuccessful: true,
        lastError: undefined,
      });

      const duration = Date.now() - startTime;
      log.info(
        `Successfully refreshed ${models.length} models for provider ${provider} in ${duration}ms`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.error(`Failed to refresh provider ${provider} after ${duration}ms`, {
        error: errorMessage,
      });

      // Update metadata with error
      await this.updateProviderMetadata(provider, {
        lastFetched: new Date(),
        modelCount: 0,
        lastFetchSuccessful: false,
        lastError: errorMessage,
      });

      if (error instanceof ModelCacheError) {
        throw error;
      }

      throw new ModelCacheError(
        `Failed to refresh provider ${provider}: ${errorMessage}`,
        provider,
        "refresh_provider",
        "REFRESH_FAILED",
        { error: errorMessage, duration }
      );
    }
  }

  /**
   * Refresh all configured providers
   */
  async refreshAllProviders(configs: Record<string, ModelFetchConfig>): Promise<void> {
    const providers = Object.keys(configs);
    const maxConcurrent = Math.min(this.config.maxConcurrentRefresh, providers.length);

    log.info(`Refreshing ${providers.length} providers with max concurrency: ${maxConcurrent}`);

    // Process in batches
    for (let i = 0; i < providers.length; i += maxConcurrent) {
      const batch = providers.slice(i, i + maxConcurrent);
      const refreshPromises = batch.map((provider) => {
        const config = configs[provider];
        if (!config) {
          log.error(`No config found for provider ${provider}`);
          return Promise.resolve();
        }
        return this.refreshProvider(provider, config).catch((error) => {
          log.error(`Failed to refresh provider ${provider}`, { error });
          // Continue with other providers even if one fails
        });
      });

      await Promise.all(refreshPromises);
    }
  }

  /**
   * Check if cache is stale for a provider
   */
  async isCacheStale(provider: string): Promise<boolean> {
    try {
      const metadata = await this.getCacheMetadata();
      const providerMetadata = metadata.providers[provider];

      if (!providerMetadata || !providerMetadata.lastFetchSuccessful) {
        return true; // No valid cache
      }

      const ttl = providerMetadata.customTtl || metadata.ttl;
      const cacheAge = Date.now() - providerMetadata.lastFetched.getTime();

      return cacheAge > ttl;
    } catch (error) {
      log.debug(`Error checking cache staleness for provider ${provider}`, { error });
      return true; // Assume stale if we can't determine
    }
  }

  /**
   * Get cache metadata
   */
  async getCacheMetadata(): Promise<ModelCacheMetadata> {
    try {
      await this.ensureCacheDirectory();

      const metadataPath = join(this.config.cacheDir, ".cache-metadata.json");

      try {
        const metadataData = await fs.readFile(metadataPath, "utf-8");
        const metadata = JSON.parse(metadataData.toString(), (key, value) => {
          // Parse dates during JSON deserialization
          if (key === "lastUpdated" || key === "nextRefresh" || key === "lastFetched") {
            return new Date(value);
          }
          return value;
        });

        return metadata;
      } catch {
        // Return default metadata if file doesn't exist
        return this.createDefaultMetadata();
      }
    } catch (error) {
      throw new ModelCacheError(
        "Failed to get cache metadata",
        "all",
        "get_cache_metadata",
        "METADATA_READ_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Clear cache for a provider
   */
  async clearProviderCache(provider: string): Promise<void> {
    try {
      const cacheFilePath = this.getProviderCacheFile(provider);

      try {
        await fs.unlink(cacheFilePath);
        log.info(`Cleared cache for provider: ${provider}`);
      } catch (error) {
        // File might not exist, which is fine
        log.debug(`Cache file not found for provider ${provider}`, { error });
      }

      // Update metadata
      const metadata = await this.getCacheMetadata();
      delete metadata.providers[provider];
      await this.saveMetadata(metadata);
    } catch (error) {
      throw new ModelCacheError(
        `Failed to clear cache for provider ${provider}`,
        provider,
        "clear_provider_cache",
        "CACHE_CLEAR_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Clear all cache data
   */
  async clearAllCache(): Promise<void> {
    try {
      await this.ensureCacheDirectory();

      const files = await fs.readdir(this.config.cacheDir);
      const cacheFiles = files.filter(
        (file) => file.endsWith("-models.json") || file === ".cache-metadata.json"
      );

      for (const file of cacheFiles) {
        await fs.unlink(join(this.config.cacheDir, file));
      }

      log.info(`Cleared all cache data (${cacheFiles.length} files)`);
    } catch (error) {
      throw new ModelCacheError(
        "Failed to clear all cache",
        "all",
        "clear_all_cache",
        "CACHE_CLEAR_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Private helper methods
   */

  private async ensureCacheDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.config.cacheDir, { recursive: true });
    } catch (error) {
      throw new ModelCacheError(
        `Failed to create cache directory: ${this.config.cacheDir}`,
        "all",
        "ensure_cache_directory",
        "DIRECTORY_CREATE_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private getProviderCacheFile(provider: string): string {
    return join(this.config.cacheDir, `${provider}-models.json`);
  }

  private async saveProviderModels(provider: string, models: CachedProviderModel[]): Promise<void> {
    await this.ensureCacheDirectory();
    const cacheFilePath = this.getProviderCacheFile(provider);
    await fs.writeFile(cacheFilePath, JSON.stringify(models, null, 2), "utf-8");
  }

  private async updateProviderMetadata(
    provider: string,
    metadata: Partial<ProviderCacheMetadata>
  ): Promise<void> {
    const fullMetadata = await this.getCacheMetadata();

    fullMetadata.providers[provider] = {
      ...fullMetadata.providers[provider],
      ...metadata,
    } as ProviderCacheMetadata;

    fullMetadata.lastUpdated = new Date();
    fullMetadata.nextRefresh = new Date(Date.now() + fullMetadata.ttl);

    await this.saveMetadata(fullMetadata);
  }

  private async saveMetadata(metadata: ModelCacheMetadata): Promise<void> {
    await this.ensureCacheDirectory();
    const metadataPath = join(this.config.cacheDir, ".cache-metadata.json");
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  }

  private createDefaultMetadata(): ModelCacheMetadata {
    const now = new Date();
    return {
      lastUpdated: now,
      ttl: this.config.defaultTtl,
      nextRefresh: new Date(now.getTime() + this.config.defaultTtl),
      version: "1.0.0",
      providers: {},
    };
  }
}
