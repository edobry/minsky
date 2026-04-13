/**
 * Tokenizer Service
 *
 * Provides model-to-tokenizer mapping and tokenization functionality
 * for AI models across different providers.
 */

import type { TokenizerInfo } from "./types";

/** Common shape of tokenizer instances returned by various libraries */
interface TokenizerInstance {
  encode(text: string): number[] | { length: number };
  decode?(tokenIds: number[]): string;
}

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
   * Tokenize text for a model/provider
   */
  tokenize(text: string, modelId: string, provider?: string): Promise<number[]>;

  /**
   * Detokenize ids back to text for a model/provider
   */
  detokenize(tokenIds: number[], modelId: string, provider?: string): Promise<string>;

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
  private tokenizerCache = new Map<string, unknown>();

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

    const tokenizer = (await this.getTokenizerInstance(tokenizerInfo)) as TokenizerInstance;
    const tokens = tokenizer.encode(text);

    return {
      tokens: (tokens as number[]).length ?? (tokens as { length: number }).length,
      characters: text.length,
      model: modelId,
      library: tokenizerInfo.library ?? "unknown",
      encoding: tokenizerInfo.encoding ?? "unknown",
    };
  }

  async tokenize(text: string, modelId: string, provider?: string): Promise<number[]> {
    const tokenizerInfo = await this.getTokenizerInfo(modelId, provider);
    if (!tokenizerInfo) {
      throw new Error(`No tokenizer found for model: ${modelId}`);
    }
    const tokenizer = (await this.getTokenizerInstance(tokenizerInfo)) as TokenizerInstance;
    return tokenizer.encode(text) as number[];
  }

  async detokenize(tokenIds: number[], modelId: string, provider?: string): Promise<string> {
    const tokenizerInfo = await this.getTokenizerInfo(modelId, provider);
    if (!tokenizerInfo) {
      throw new Error(`No tokenizer found for model: ${modelId}`);
    }
    const tokenizer = (await this.getTokenizerInstance(tokenizerInfo)) as TokenizerInstance;
    if (typeof tokenizer.decode === "function") {
      return tokenizer.decode(tokenIds);
    }
    // Fallback: join by spaces (rough) if decoder not available
    return tokenIds.join(" ");
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
  private async getTokenizerInstance(tokenizerInfo: TokenizerInfo): Promise<unknown> {
    const cacheKey = `${tokenizerInfo.library}:${tokenizerInfo.encoding}`;

    if (this.tokenizerCache.has(cacheKey)) {
      return this.tokenizerCache.get(cacheKey);
    }

    let tokenizer: unknown;

    switch (tokenizerInfo.library) {
      case "gpt-tokenizer":
        tokenizer = await this.createGptTokenizer(tokenizerInfo.encoding ?? "cl100k_base");
        break;
      case "tiktoken":
        tokenizer = await this.createTiktokenTokenizer(tokenizerInfo.encoding ?? "cl100k_base");
        break;
      case "anthropic":
        tokenizer = await this.createAnthropicTokenizer(tokenizerInfo.encoding ?? "cl100k_base");
        break;
      case "google":
        tokenizer = await this.createGoogleTokenizer(tokenizerInfo.encoding ?? "cl100k_base");
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
  private async createGptTokenizer(encoding: string): Promise<unknown> {
    try {
      // gpt-tokenizer exports named encode/decode functions per encoding module.
      // Use o200k_base for gpt-4o models, cl100k_base for others.
      const modulePath =
        encoding === "o200k_base" ? "gpt-tokenizer/o200k_base" : "gpt-tokenizer/cl100k_base";
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        encode: (text: string) => number[];
        decode: (tokens: Iterable<number>) => string;
      };
      const instance: TokenizerInstance = {
        encode: (text: string) => mod.encode(text),
        decode: (tokens: number[]) => mod.decode(tokens),
      };
      return instance;
    } catch (error) {
      throw new Error(`Failed to load gpt-tokenizer: ${error}`);
    }
  }

  /**
   * Create tiktoken instance
   */
  private async createTiktokenTokenizer(encoding: string): Promise<unknown> {
    try {
      const { get_encoding } = await import("tiktoken");
      type TiktokenEncoding =
        | "gpt2"
        | "r50k_base"
        | "p50k_base"
        | "p50k_edit"
        | "cl100k_base"
        | "o200k_base";
      const knownEncodings: TiktokenEncoding[] = [
        "gpt2",
        "r50k_base",
        "p50k_base",
        "p50k_edit",
        "cl100k_base",
        "o200k_base",
      ];
      const safeEncoding: TiktokenEncoding = knownEncodings.includes(encoding as TiktokenEncoding)
        ? (encoding as TiktokenEncoding)
        : "cl100k_base";
      return get_encoding(safeEncoding);
    } catch (error) {
      throw new Error(`Failed to load tiktoken: ${error}`);
    }
  }

  /**
   * Create Anthropic tokenizer (placeholder - would need actual implementation)
   */
  private async createAnthropicTokenizer(encoding: string): Promise<unknown> {
    // For now, fallback to tiktoken for Claude models
    // In a real implementation, we'd use Anthropic's tokenizer if available
    return this.createTiktokenTokenizer("cl100k_base");
  }

  /**
   * Create Google tokenizer (placeholder - would need actual implementation)
   */
  private async createGoogleTokenizer(encoding: string): Promise<unknown> {
    // For now, fallback to tiktoken for Gemini models
    // In a real implementation, we'd use Google's tokenizer if available
    return this.createTiktokenTokenizer("cl100k_base");
  }
}

/**
 * Global instance for convenience
 */
export const defaultTokenizerService = new DefaultTokenizerService();
