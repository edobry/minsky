import { MINUTE_IN_SECONDS } from "../utils/constants";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Repository utilities for Minsky.
 * Provides caching and common functions for repository operations.
 */

/**
 * Cache entry with timestamp for expiration.
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Repository metadata cache singleton.
 * Provides caching for repository operations to improve performance.
 */
export class RepositoryMetadataCache {
  private static instance: RepositoryMetadataCache;
  private cache: Map<string, CacheEntry<any>> = new Map();

  /**
   * Default TTL for cache entries in milliseconds (5 minutes).
   */
  private readonly DEFAULT_TTL = 5 * MINUTE_IN_SECONDS * DEFAULT_TIMEOUT_MS;

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor() {}

  /**
   * Get the singleton instance of the cache.
   * @returns The singleton instance
   */
  static getInstance(): RepositoryMetadataCache {
    if (!RepositoryMetadataCache.instance) {
      RepositoryMetadataCache.instance = new RepositoryMetadataCache();
    }
    return RepositoryMetadataCache.instance;
  }

  /**
   * Get a value from the cache, or fetch it if it doesn't exist or is expired.
   *
   * @param key Cache key
   * @param fetcher Function to fetch the value if it's not in the cache
   * @param ttl Time to live in milliseconds (defaults to DEFAULT_RETRY_COUNT minutes)
   * @returns The cached or fetched value
   */
  async get<T>(key: string, fetcher: () => Promise<T>, ttl: number = this.DEFAULT_TTL): Promise<T> {
    const cacheEntry = this.cache.get(key) as CacheEntry<T> | undefined;
    const now = Date.now();

    // If the entry exists and is not expired, return it
    if (cacheEntry && now - cacheEntry.timestamp < ttl) {
      return cacheEntry.data;
    }

    // Otherwise fetch the data and update the cache
    const data = await fetcher();
    this.cache.set(key, { data, timestamp: now });
    return data;
  }

  /**
   * Set a value in the cache with the current timestamp.
   *
   * @param key Cache key
   * @param data Data to cache
   */
  set<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Invalidate a single cache entry.
   *
   * @param key Cache key to invalidate
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all cache entries matching a prefix.
   * Useful for invalidating all entries related to a specific repository.
   *
   * @param prefix Cache key prefix to match
   */
  invalidateByPrefix(prefix: string): void {
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all cache entries.
   */
  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Generate a cache key for a repository operation.
 *
 * @param repoPath Repository path
 * @param operation Operation name
 * @param params Additional parameters to include in the key
 * @returns The cache key
 */
export function generateRepoKey(
  repoPath: string,
  operation: string,
  params?: Record<string, any>
): string {
  let key = `repo:${repoPath}:${operation}`;

  if (params) {
    key += `:${JSON.stringify(params)}`;
  }

  return key;
}

/**
 * Repository error for handling Git and repository-related errors.
 */
export class RepositoryError extends Error {
  /**
   * Create a new repository error.
   *
   * @param message Error message
   * @param cause Underlying cause of the error
   */
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}
