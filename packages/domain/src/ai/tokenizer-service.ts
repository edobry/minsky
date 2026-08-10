/**
 * Tokenizer Service
 *
 * Provides model-to-tokenizer mapping and tokenization functionality
 * for AI models across different providers.
 */

import { injectable } from "tsyringe";
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
@injectable()
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
    // `source` distinguishes a tokenizer we know is right for the model
    // ("config") from one substituted because none exists ("fallback"). Every
    // branch below reported "fallback" regardless, which made the field useless
    // in both directions: it understated the OpenAI matches and gave the Claude
    // and Gemini approximations no distinguishing mark (mt#3928).

    // OpenAI model patterns — these encodings ARE these models' tokenizers.
    if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1")) {
      return {
        encoding: "o200k_base",
        library: "gpt-tokenizer",
        source: "config",
      };
    }

    if (modelId.startsWith("gpt-4") || modelId.startsWith("gpt-3.5")) {
      return {
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "config",
      };
    }

    // Claude and Gemini keep "fallback", which is already correct: neither
    // vendor publishes a local BPE (Anthropic exposes a `count_tokens` API
    // endpoint instead), so `createAnthropicTokenizer` / `createGoogleTokenizer`
    // below both return tiktoken `cl100k_base` whatever these encodings say.
    // Those names are labels for a tokenizer that does not exist here; dispatch
    // is on `library`, so correcting them is cosmetic and out of scope for
    // mt#3928 — `source` is the field that has to be right.
    if (modelId.includes("claude")) {
      return {
        encoding: "claude-3",
        library: "anthropic",
        source: "fallback",
      };
    }

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
      //
      // mt#3370: the subpath is `encoding/<name>`, NOT a bare `<name>`. The
      // bare form is the v2 layout; `gpt-tokenizer@3.0.1` — the version this
      // repo declares — exposes only `.`, `./*`, `./cjs`, `./cjs/*`, `./esm/*`,
      // `./data/*` and `./package.json`, under which `gpt-tokenizer/cl100k_base`
      // resolves to nothing. So EVERY call threw `Failed to load gpt-tokenizer`
      // and the accurate token count was never available anywhere — callers
      // silently degraded to a ~4-chars-per-token heuristic.
      //
      // That heuristic under-truncates dense markdown (~3 chars/token), which
      // is how mt#2861 kept overflowing OpenAI's 8192-token input limit even
      // after "truncation": 38,547 chars capped to 32,000 is still ~10.6k
      // tokens. Verified under bun: the bare path FAILS, `encoding/cl100k_base`
      // resolves and exports `encode`.
      const modulePath =
        encoding === "o200k_base"
          ? "gpt-tokenizer/encoding/o200k_base"
          : "gpt-tokenizer/encoding/cl100k_base";
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
