/**
 * Tokenizer Registry
 *
 * Manages multiple tokenization libraries and provides intelligent selection logic.
 * Handles preferences, fallbacks, and model-specific tokenizer routing.
 */

import type { LocalTokenizer, TokenizerRegistry, TokenizerConfig } from "./types";
import { GptTokenizer } from "./gpt-tokenizer";
import { TiktokenTokenizer } from "./tiktoken-tokenizer";
import { log } from "../../../utils/logger";

/**
 * Default tokenizer registry implementation
 */
export class DefaultTokenizerRegistry implements TokenizerRegistry {
  private tokenizers = new Map<string, LocalTokenizer>();
  private preferences = new Map<string, string>();
  private config: TokenizerConfig;

  constructor(config: TokenizerConfig = {}) {
    this.config = {
      defaultLibrary: "gpt-tokenizer",
      enableCaching: true,
      cacheTtl: 60000, // 1 minute
      ...config,
    };

    // Register built-in tokenizers
    this.registerBuiltinTokenizers();
  }

  /**
   * Register built-in tokenizers
   */
  private registerBuiltinTokenizers(): void {
    try {
      // Register gpt-tokenizer (preferred for OpenAI models)
      const gptTokenizer = new GptTokenizer();
      this.register(gptTokenizer);
      log.debug("Registered gpt-tokenizer");

      // Register tiktoken (fallback)
      const tiktokenTokenizer = new TiktokenTokenizer();
      this.register(tiktokenTokenizer);
      log.debug("Registered tiktoken");

      log.info(`Tokenizer registry initialized with ${this.tokenizers.size} tokenizers`);
    } catch (error) {
      log.error("Failed to register built-in tokenizers", { error });
      throw new Error(`Failed to initialize tokenizer registry: ${error}`);
    }
  }

  /**
   * Register a tokenizer implementation
   */
  register(tokenizer: LocalTokenizer): void {
    this.tokenizers.set(tokenizer.id, tokenizer);
    log.debug(`Registered tokenizer: ${tokenizer.id} (${tokenizer.library})`);
  }

  /**
   * Get the best tokenizer for a specific model
   */
  getForModel(modelId: string): LocalTokenizer | null {
    // Check for explicit preference
    const preferredTokenizer = this.preferences.get(modelId);
    if (preferredTokenizer && this.tokenizers.has(preferredTokenizer)) {
      const tokenizer = this.tokenizers.get(preferredTokenizer)!;
      if (tokenizer.supportsModel(modelId)) {
        log.debug(`Using preferred tokenizer for ${modelId}: ${preferredTokenizer}`);
        return tokenizer;
      }
    }

    // Check config overrides
    if (this.config.modelOverrides?.[modelId]) {
      const override = this.config.modelOverrides[modelId];
      const tokenizer = this.tokenizers.get(override.tokenizer);
      if (tokenizer && tokenizer.supportsModel(modelId)) {
        log.debug(`Using config override tokenizer for ${modelId}: ${override.tokenizer}`);
        return tokenizer;
      }
    }

    // Find best matching tokenizer based on priority and support
    const candidates = Array.from(this.tokenizers.values())
      .filter((tokenizer) => tokenizer.supportsModel(modelId))
      .sort(
        (a, b) => this.getTokenizerPriority(b, modelId) - this.getTokenizerPriority(a, modelId)
      );

    if (candidates.length > 0) {
      log.debug(`Selected tokenizer for ${modelId}: ${candidates[0].id}`);
      return candidates[0];
    }

    // Fallback to default library
    if (this.config.defaultLibrary) {
      const fallback = this.tokenizers.get(this.config.defaultLibrary);
      if (fallback) {
        log.warn(
          `No specific tokenizer found for ${modelId}, using fallback: ${this.config.defaultLibrary}`
        );
        return fallback;
      }
    }

    log.error(`No suitable tokenizer found for model: ${modelId}`);
    return null;
  }

  /**
   * Get priority score for a tokenizer with a specific model
   */
  private getTokenizerPriority(tokenizer: LocalTokenizer, modelId: string): number {
    let priority = 0;

    // Prefer gpt-tokenizer for OpenAI models (higher performance)
    if (tokenizer.id === "gpt-tokenizer" && this.isOpenAIModel(modelId)) {
      priority += 100;
    }

    // Prefer tiktoken as general fallback
    if (tokenizer.id === "tiktoken") {
      priority += 50;
    }

    // Boost priority if explicitly configured as default
    if (tokenizer.library === this.config.defaultLibrary) {
      priority += 25;
    }

    return priority;
  }

  /**
   * Check if a model is an OpenAI model
   */
  private isOpenAIModel(modelId: string): boolean {
    const openaiPrefixes = ["gpt-", "o1-", "o3-", "davinci", "curie", "babbage", "ada"];
    return openaiPrefixes.some((prefix) => modelId.startsWith(prefix));
  }

  /**
   * Get all available tokenizers
   */
  listAvailable(): LocalTokenizer[] {
    return Array.from(this.tokenizers.values());
  }

  /**
   * Set preference for a specific model
   */
  setPreference(modelId: string, tokenizerId: string): void {
    if (!this.tokenizers.has(tokenizerId)) {
      throw new Error(`Tokenizer not found: ${tokenizerId}`);
    }

    this.preferences.set(modelId, tokenizerId);
    log.debug(`Set tokenizer preference for ${modelId}: ${tokenizerId}`);
  }

  /**
   * Get preferences mapping
   */
  getPreferences(): Record<string, string> {
    return Object.fromEntries(this.preferences);
  }

  /**
   * Check if a tokenizer is available
   */
  isAvailable(tokenizerId: string): boolean {
    return this.tokenizers.has(tokenizerId);
  }

  /**
   * Get tokenizer by ID
   */
  getTokenizer(tokenizerId: string): LocalTokenizer | null {
    return this.tokenizers.get(tokenizerId) || null;
  }

  /**
   * Get supported models for all tokenizers
   */
  getSupportedModels(): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const [id, tokenizer] of this.tokenizers) {
      result[id] = tokenizer.supportedModels;
    }

    return result;
  }

  /**
   * Find tokenizers that support a specific model
   */
  getTokenizersForModel(modelId: string): LocalTokenizer[] {
    return Array.from(this.tokenizers.values()).filter((tokenizer) =>
      tokenizer.supportsModel(modelId)
    );
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TokenizerConfig>): void {
    this.config = { ...this.config, ...config };

    // Apply new preferences from config
    if (config.modelOverrides) {
      for (const [modelId, preference] of Object.entries(config.modelOverrides)) {
        this.setPreference(modelId, preference.tokenizer);
      }
    }

    log.debug("Updated tokenizer registry configuration", { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): TokenizerConfig {
    return { ...this.config };
  }

  /**
   * Clear all preferences
   */
  clearPreferences(): void {
    this.preferences.clear();
    log.debug("Cleared all tokenizer preferences");
  }
}
