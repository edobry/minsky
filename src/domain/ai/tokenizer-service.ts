/**
 * Tokenizer Service
 *
 * Provides model-to-tokenizer mapping and tokenization functionality
 * for AI models across different providers.
 */

import type { AIModel, TokenizerInfo } from "./types";

// Token counting interface
export interface TokenCount {
  tokens: number;
  characters: number;
  model: string;
  library: string;
  encoding: string;
}

// Tokenizer service interface
export interface TokenizerService {
  /**
   * Get tokenizer information for a specific model
   */
  getTokenizerInfo(modelId: string, provider?: string): Promise<TokenizerInfo | null>;

  /**
   * Count tokens for text using the appropriate tokenizer for the model
   */
  countTokens(text: string, modelId: string, provider?: string): Promise<TokenCount>;

  /**
   * Get fallback tokenizer for a provider when model-specific info is unavailable
   */
  getFallbackTokenizer(provider: string): TokenizerInfo;

  /**
   * Register custom tokenizer mapping
   */
  registerTokenizer(modelId: string, tokenizerInfo: TokenizerInfo): void;
}

/**
 * Default implementation of TokenizerService
 */
export class DefaultTokenizerService implements TokenizerService {
  private customTokenizers = new Map<string, TokenizerInfo>();
  private tokenizerCache = new Map<string, any>();

  /**
   * Get tokenizer information for a model
   */
  async getTokenizerInfo(modelId: string, provider?: string): Promise<TokenizerInfo | null> {
    // Check custom registered tokenizers first
    const customTokenizer = this.customTokenizers.get(modelId);
    if (customTokenizer) {
      return customTokenizer;
    }

    // Try to detect tokenizer from model metadata
    const detectedTokenizer = this.detectTokenizerFromModel(modelId, provider);
    if (detectedTokenizer) {
      return detectedTokenizer;
    }

    // Fallback to provider default
    if (provider) {
      return this.getFallbackTokenizer(provider);
    }

    return null;
  }

  /**
   * Count tokens using appropriate tokenizer
   */
  async countTokens(text: string, modelId: string, provider?: string): Promise<TokenCount> {
    const tokenizerInfo = await this.getTokenizerInfo(modelId, provider);

    if (!tokenizerInfo) {
      throw new Error(`No tokenizer found for model: ${modelId}`);
    }

    const tokenizer = await this.getTokenizerInstance(tokenizerInfo);
    const tokens = tokenizer.encode(text);

    return {
      tokens: tokens.length,
      characters: text.length,
      model: modelId,
      library: tokenizerInfo.library,
      encoding: tokenizerInfo.encoding,
    };
  }

  /**
   * Get fallback tokenizer for provider
   */
  getFallbackTokenizer(provider: string): TokenizerInfo {
    const fallbackMap: Record<string, TokenizerInfo> = {
      openai: {
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      },
      anthropic: {
        encoding: "claude-3",
        library: "anthropic",
        source: "fallback",
      },
      google: {
        encoding: "gemini",
        library: "google",
        source: "fallback",
      },
      morph: {
        encoding: "cl100k_base", // Morph likely uses OpenAI-compatible tokenization
        library: "gpt-tokenizer",
        source: "fallback",
      },
    };

    return (
      fallbackMap[provider] || {
        encoding: "cl100k_base",
        library: "tiktoken",
        source: "fallback",
      }
    );
  }

  /**
   * Register custom tokenizer
   */
  registerTokenizer(modelId: string, tokenizerInfo: TokenizerInfo): void {
    this.customTokenizers.set(modelId, tokenizerInfo);
  }

  /**
   * Detect tokenizer from model ID patterns
   */
  private detectTokenizerFromModel(modelId: string, provider?: string): TokenizerInfo | null {
    // OpenAI model patterns
    if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1")) {
      return {
        encoding: "o200k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      };
    }

    if (modelId.startsWith("gpt-4") || modelId.startsWith("gpt-3.5")) {
      return {
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      };
    }

    // Claude model patterns
    if (modelId.includes("claude")) {
      return {
        encoding: "claude-3",
        library: "anthropic",
        source: "fallback",
      };
    }

    // Gemini model patterns
    if (modelId.includes("gemini")) {
      return {
        encoding: "gemini",
        library: "google",
        source: "fallback",
      };
    }

    return null;
  }

  /**
   * Get cached tokenizer instance
   */
  private async getTokenizerInstance(tokenizerInfo: TokenizerInfo): Promise<any> {
    const cacheKey = `${tokenizerInfo.library}:${tokenizerInfo.encoding}`;

    if (this.tokenizerCache.has(cacheKey)) {
      return this.tokenizerCache.get(cacheKey);
    }

    let tokenizer: any;

    switch (tokenizerInfo.library) {
      case "gpt-tokenizer":
        tokenizer = await this.createGptTokenizer(tokenizerInfo.encoding);
        break;
      case "tiktoken":
        tokenizer = await this.createTiktokenTokenizer(tokenizerInfo.encoding);
        break;
      case "anthropic":
        tokenizer = await this.createAnthropicTokenizer(tokenizerInfo.encoding);
        break;
      case "google":
        tokenizer = await this.createGoogleTokenizer(tokenizerInfo.encoding);
        break;
      default:
        throw new Error(`Unsupported tokenizer library: ${tokenizerInfo.library}`);
    }

    this.tokenizerCache.set(cacheKey, tokenizer);
    return tokenizer;
  }

  /**
   * Create gpt-tokenizer instance
   */
  private async createGptTokenizer(encoding: string): Promise<any> {
    try {
      const { GPTTokens } = await import("gpt-tokenizer");
      return new GPTTokens({
        model: encoding === "o200k_base" ? "gpt-4o" : "gpt-4",
        training: false,
      });
    } catch (error) {
      throw new Error(`Failed to load gpt-tokenizer: ${error}`);
    }
  }

  /**
   * Create tiktoken instance
   */
  private async createTiktokenTokenizer(encoding: string): Promise<any> {
    try {
      const { get_encoding } = await import("tiktoken");
      return get_encoding(encoding as any);
    } catch (error) {
      throw new Error(`Failed to load tiktoken: ${error}`);
    }
  }

  /**
   * Create Anthropic tokenizer (placeholder - would need actual implementation)
   */
  private async createAnthropicTokenizer(encoding: string): Promise<any> {
    // For now, fallback to tiktoken for Claude models
    // In a real implementation, we'd use Anthropic's tokenizer if available
    return this.createTiktokenTokenizer("cl100k_base");
  }

  /**
   * Create Google tokenizer (placeholder - would need actual implementation)
   */
  private async createGoogleTokenizer(encoding: string): Promise<any> {
    // For now, fallback to tiktoken for Gemini models
    // In a real implementation, we'd use Google's tokenizer if available
    return this.createTiktokenTokenizer("cl100k_base");
  }
}

/**
 * Global instance for convenience
 */
export const defaultTokenizerService = new DefaultTokenizerService();
