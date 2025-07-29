/**
 * AI Model Cache Types
 *
 * Types and interfaces for the dynamic model data fetching and caching system.
 * Separate from configuration types as this handles cached API data, not user settings.
 */

import { AIModel, AICapability } from "../types";

/**
 * Cached provider model data with metadata
 */
export interface CachedProviderModel extends AIModel {
  /** When this model data was fetched */
  fetchedAt: Date;
  /** API-specific model metadata */
  providerMetadata?: Record<string, any>;
  /** Whether this model is currently available */
  status: "available" | "deprecated" | "disabled" | "unknown";
}

/**
 * Cache metadata for TTL and refresh management
 */
export interface ModelCacheMetadata {
  /** When the cache was last updated */
  lastUpdated: Date;
  /** TTL in milliseconds (default: 24 hours) */
  ttl: number;
  /** Next scheduled refresh time */
  nextRefresh: Date;
  /** Cache version for migration support */
  version: string;
  /** Per-provider metadata */
  providers: Record<string, ProviderCacheMetadata>;
}

/**
 * Per-provider cache metadata
 */
export interface ProviderCacheMetadata {
  /** When this provider's models were last fetched */
  lastFetched: Date;
  /** Number of models cached for this provider */
  modelCount: number;
  /** Whether the last fetch was successful */
  lastFetchSuccessful: boolean;
  /** Error message if last fetch failed */
  lastError?: string;
  /** Custom TTL override for this provider */
  customTtl?: number;
}

/**
 * Model fetcher interface for provider-specific implementations
 */
export interface ModelFetcher {
  /** Provider identifier */
  readonly provider: string;

  /** Fetch models from provider API */
  fetchModels(config: ModelFetchConfig): Promise<CachedProviderModel[]>;

  /** Get capabilities for a specific model */
  getModelCapabilities(modelId: string): Promise<AICapability[]>;

  /** Validate API connectivity */
  validateConnection(config: ModelFetchConfig): Promise<boolean>;
}

/**
 * Configuration for model fetching
 */
export interface ModelFetchConfig {
  /** API key for the provider */
  apiKey: string;
  /** Custom base URL if different from default */
  baseURL?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Additional provider-specific options */
  options?: Record<string, any>;
}

/**
 * Cache service interface
 */
export interface ModelCacheService {
  /** Get cached models for a provider */
  getCachedModels(provider: string): Promise<CachedProviderModel[]>;

  /** Get all cached models */
  getAllCachedModels(): Promise<Record<string, CachedProviderModel[]>>;

  /** Refresh models for a specific provider */
  refreshProvider(provider: string, config: ModelFetchConfig): Promise<void>;

  /** Refresh all configured providers */
  refreshAllProviders(configs: Record<string, ModelFetchConfig>): Promise<void>;

  /** Check if cache is stale for a provider */
  isCacheStale(provider: string): Promise<boolean>;

  /** Get cache metadata */
  getCacheMetadata(): Promise<ModelCacheMetadata>;

  /** Clear cache for a provider */
  clearProviderCache(provider: string): Promise<void>;

  /** Clear all cache data */
  clearAllCache(): Promise<void>;
}

/**
 * Cache refresh result
 */
export interface CacheRefreshResult {
  /** Provider that was refreshed */
  provider: string;
  /** Whether refresh was successful */
  success: boolean;
  /** Number of models fetched */
  modelCount: number;
  /** Error message if failed */
  error?: string;
  /** Duration of the refresh operation */
  duration: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Cache directory path */
  cacheDir: string;
  /** Default TTL in milliseconds */
  defaultTtl: number;
  /** Request timeout for API calls */
  requestTimeout: number;
  /** Whether to auto-refresh stale cache */
  autoRefresh: boolean;
  /** Maximum concurrent refresh operations */
  maxConcurrentRefresh: number;
}

/**
 * Error types for model cache operations
 */
export class ModelCacheError extends Error {
  constructor(
    message: string,
    public provider: string,
    public operation: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = "ModelCacheError";
  }
}

export class ModelFetchError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code: string,
    public statusCode?: number,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = "ModelFetchError";
  }
}
