/**
 * Tokenization Service
 *
 * High-level service for tokenization operations with caching,
 * model-aware selection, and cross-tokenizer comparison.
 */

import type {
  TokenizationService,
  LocalTokenizer,
  TokenizerMetadata,
  TokenizerComparison,
  TokenizationCacheEntry,
} from "./types";
import { DefaultTokenizerRegistry } from "./registry";
import { TokenizationError, TokenizerNotFoundError } from "./types";
import { log } from "../../../utils/logger";

/**
 * Default tokenization service implementation
 */
export class DefaultTokenizationService implements TokenizationService {
  private registry: DefaultTokenizerRegistry;
  private cache = new Map<string, TokenizationCacheEntry>();
  private cacheEnabled: boolean;
  private cacheTtl: number;

  constructor(registry?: DefaultTokenizerRegistry) {
    this.registry = registry || new DefaultTokenizerRegistry();
    this.cacheEnabled = true;
    this.cacheTtl = 60000; // 1 minute
  }

  /**
   * Count tokens for text using appropriate tokenizer for model
   */
  async countTokens(text: string, model: string): Promise<number> {
    const cacheKey = this.getCacheKey(text, model, "default");

    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        log.debug(`Cache hit for token count: ${model}`);
        return cached.tokenCount;
      }
    }

    // Get appropriate tokenizer
    const tokenizer = this.registry.getForModel(model);
    if (!tokenizer) {
      throw new TokenizerNotFoundError(`No suitable tokenizer found for model: ${model}`, model);
    }

    try {
      const startTime = Date.now();
      const tokenCount = tokenizer.countTokens(text, model);
      const duration = Date.now() - startTime;

      // Cache the result
      if (this.cacheEnabled) {
        this.cacheResult(cacheKey, text, model, tokenizer.id, tokenCount);
      }

      log.debug(`Tokenized text for ${model} using ${tokenizer.id}`, {
        tokenCount,
        duration,
        textLength: text.length,
      });

      return tokenCount;
    } catch (error) {
      throw new TokenizationError(
        `Failed to count tokens: ${error}`,
        tokenizer.id,
        model,
        "COUNT_FAILED",
        { textLength: text.length }
      );
    }
  }

  /**
   * Count tokens using specific tokenizer
   */
  async countTokensWithTokenizer(text: string, tokenizerId: string): Promise<number> {
    const tokenizer = this.registry.getTokenizer(tokenizerId);
    if (!tokenizer) {
      throw new TokenizerNotFoundError(
        `Tokenizer not found: ${tokenizerId}`,
        "unknown",
        tokenizerId
      );
    }

    const cacheKey = this.getCacheKey(text, "unknown", tokenizerId);

    // Check cache
    if (this.cacheEnabled) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        return cached.tokenCount;
      }
    }

    try {
      const tokenCount = tokenizer.countTokens(text);

      // Cache the result
      if (this.cacheEnabled) {
        this.cacheResult(cacheKey, text, "unknown", tokenizerId, tokenCount);
      }

      return tokenCount;
    } catch (error) {
      throw new TokenizationError(
        `Failed to count tokens with ${tokenizerId}: ${error}`,
        tokenizerId,
        "unknown",
        "COUNT_FAILED"
      );
    }
  }

  /**
   * Get available tokenizers for a model
   */
  async getAvailableTokenizers(model: string): Promise<LocalTokenizer[]> {
    return this.registry.getTokenizersForModel(model);
  }

  /**
   * Get tokenizer metadata for a model
   */
  async getTokenizerMetadata(model: string): Promise<TokenizerMetadata | null> {
    const tokenizer = this.registry.getForModel(model);
    if (!tokenizer) {
      return null;
    }

    // Create metadata from tokenizer information
    const metadata: TokenizerMetadata = {
      id: this.getTokenizerEncoding(tokenizer, model),
      type: "bpe", // Most modern tokenizers are BPE
      source: "config", // From our configuration
      library: tokenizer.library,
      metadata: {
        tokenizerId: tokenizer.id,
        tokenizerName: tokenizer.name,
        supportedModels: tokenizer.supportedModels,
      },
    };

    return metadata;
  }

  /**
   * Batch count tokens for multiple texts
   */
  async batchCountTokens(texts: string[], model: string): Promise<number[]> {
    const tokenizer = this.registry.getForModel(model);
    if (!tokenizer) {
      throw new TokenizerNotFoundError(`No suitable tokenizer found for model: ${model}`, model);
    }

    const results: number[] = [];

    for (const text of texts) {
      try {
        const count = await this.countTokens(text, model);
        results.push(count);
      } catch (error) {
        log.warn(`Failed to count tokens for text in batch`, { error, model });
        results.push(0); // Fallback value
      }
    }

    return results;
  }

  /**
   * Compare token counts across different tokenizers
   */
  async compareTokenizers(text: string, model: string): Promise<TokenizerComparison[]> {
    const availableTokenizers = await this.getAvailableTokenizers(model);
    const comparisons: TokenizerComparison[] = [];

    for (const tokenizer of availableTokenizers) {
      const startTime = Date.now();
      let tokenCount = 0;
      let success = true;
      let error: string | undefined;

      try {
        tokenCount = tokenizer.countTokens(text, model);
      } catch (err) {
        success = false;
        error = String(err);
        log.warn(`Tokenizer comparison failed for ${tokenizer.id}`, { error: err });
      }

      const duration = Date.now() - startTime;

      comparisons.push({
        tokenizer,
        tokenCount,
        duration,
        success,
        error,
      });
    }

    // Sort by success, then by duration
    return comparisons.sort((a, b) => {
      if (a.success !== b.success) {
        return b.success ? 1 : -1;
      }
      return a.duration - b.duration;
    });
  }

  /**
   * Generate cache key for tokenization result
   */
  private getCacheKey(text: string, model: string, tokenizerId: string): string {
    const textHash = this.hashText(text);
    return `${model}:${tokenizerId}:${textHash}`;
  }

  /**
   * Simple hash function for text
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get cached tokenization result
   */
  private getCachedResult(cacheKey: string): TokenizationCacheEntry | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      return null;
    }

    // Check if cache entry is still valid
    const now = Date.now();
    const age = now - entry.timestamp.getTime();

    if (age > this.cacheTtl) {
      this.cache.delete(cacheKey);
      return null;
    }

    return entry;
  }

  /**
   * Cache tokenization result
   */
  private cacheResult(
    cacheKey: string,
    text: string,
    model: string,
    tokenizerId: string,
    tokenCount: number
  ): void {
    const entry: TokenizationCacheEntry = {
      text,
      model,
      tokenizerId,
      tokenCount,
      timestamp: new Date(),
      textHash: this.hashText(text),
    };

    this.cache.set(cacheKey, entry);

    // Clean up old entries periodically
    if (this.cache.size > 1000) {
      this.cleanupCache();
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp.getTime();
      if (age > this.cacheTtl) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }

    log.debug(`Cleaned up ${toDelete.length} expired cache entries`);
  }

  /**
   * Get tokenizer encoding name for a model
   */
  private getTokenizerEncoding(tokenizer: LocalTokenizer, model: string): string {
    // Try to get encoding from tokenizer if it supports this method
    if ("getModelEncoding" in tokenizer && typeof tokenizer.getModelEncoding === "function") {
      return (tokenizer as any).getModelEncoding(model);
    }

    if ("getEncodingForModel" in tokenizer && typeof tokenizer.getEncodingForModel === "function") {
      return (tokenizer as any).getEncodingForModel(model);
    }

    // Default based on model patterns
    if (model.startsWith("gpt-4o") || model.startsWith("o1") || model.startsWith("o3")) {
      return "o200k_base";
    } else if (model.startsWith("gpt-4") || model.startsWith("gpt-3.5")) {
      return "cl100k_base";
    }

    return "cl100k_base"; // Safe default
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    log.debug("Cleared tokenization cache");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; ttl: number; enabled: boolean } {
    return {
      size: this.cache.size,
      ttl: this.cacheTtl,
      enabled: this.cacheEnabled,
    };
  }

  /**
   * Configure caching
   */
  configureCaching(enabled: boolean, ttl?: number): void {
    this.cacheEnabled = enabled;
    if (ttl !== undefined) {
      this.cacheTtl = ttl;
    }

    if (!enabled) {
      this.clearCache();
    }

    log.debug("Updated tokenization cache configuration", {
      enabled: this.cacheEnabled,
      ttl: this.cacheTtl,
    });
  }
}
