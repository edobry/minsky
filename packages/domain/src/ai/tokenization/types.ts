/**
 * Tokenization Infrastructure Types
 *
 * Types and interfaces for the multi-library tokenization system.
 * Supports gpt-tokenizer, tiktoken, and extensible architecture for additional libraries.
 */

/**
 * Unified tokenizer interface for different tokenization implementations
 */
export interface LocalTokenizer {
  /** Unique identifier for the tokenizer */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Library providing this tokenizer (e.g., "gpt-tokenizer", "tiktoken") */
  readonly library: string;

  /** Models that this tokenizer supports */
  readonly supportedModels: string[];

  /** Encode text to tokens */
  encode(text: string, model?: string): number[];

  /** Decode tokens to text */
  decode(tokens: number[], model?: string): string;

  /** Count tokens in text (optimized method, may not require full encoding) */
  countTokens(text: string, model?: string): number;

  /** Check if a model is supported by this tokenizer */
  supportsModel(model: string): boolean;
}

/**
 * Tokenizer registry for managing multiple tokenization libraries
 */
export interface TokenizerRegistry {
  /** Register a tokenizer implementation */
  register(tokenizer: LocalTokenizer): void;

  /** Get the best tokenizer for a specific model */
  getForModel(modelId: string): LocalTokenizer | null;

  /**
   * Resolve a tokenizer for a model, reporting whether it was matched or
   * substituted. Prefer this over `getForModel`, which cannot express the
   * difference (mt#3928).
   */
  resolveForModel(modelId: string): TokenizerResolution | null;

  /** Get all available tokenizers */
  listAvailable(): LocalTokenizer[];

  /** Set preference for a specific model */
  setPreference(modelId: string, tokenizerId: string): void;

  /** Get preferences mapping */
  getPreferences(): Record<string, string>;

  /** Check if a tokenizer is available */
  isAvailable(tokenizerId: string): boolean;
}

/**
 * The outcome of resolving a tokenizer for a model.
 *
 * `getForModel` collapses two different outcomes into one return value: a
 * tokenizer that DECLARES support for this model, and the default library
 * handed back because nothing matched. Only a `log.warn` distinguished them,
 * so every caller presented an OpenAI-BPE approximation of an Anthropic model
 * as a measurement (mt#3928). This carries the distinction to the caller.
 */
export interface TokenizerResolution {
  tokenizer: LocalTokenizer;

  /**
   * `"config"` when a registered tokenizer declares support for this model;
   * `"fallback"` when none did and the default library was substituted.
   */
  source: "config" | "fallback";
}

/**
 * Tokenizer metadata for model information
 */
export interface TokenizerMetadata {
  /** Tokenizer identifier (e.g., "cl100k_base", "o200k_base") */
  id: string;

  /** Tokenizer type (e.g., "bpe", "sentencepiece") */
  type: string;

  /**
   * Source of tokenizer information.
   *
   * Was hardcoded to `"config"` at the one site that produced it, so the field
   * could not distinguish a matched tokenizer from a substituted one (mt#3928).
   */
  source: "api" | "config" | "fallback";

  /**
   * True when no registered tokenizer declares support for this model, so the
   * counts it produces approximate the model rather than measure it.
   *
   * Equivalent to `source === "fallback"`; named separately because it is what
   * display code branches on, and "is this number an approximation?" should not
   * require knowing that one enum member implies it.
   */
  approximated: boolean;

  /** Preferred library for this tokenizer */
  library?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Tokenization service interface
 */
export interface TokenizationService {
  /** Count tokens for text using appropriate tokenizer for model */
  countTokens(text: string, model: string): Promise<number>;

  /** Count tokens using specific tokenizer */
  countTokensWithTokenizer(text: string, tokenizerId: string): Promise<number>;

  /** Get available tokenizers for a model */
  getAvailableTokenizers(model: string): Promise<LocalTokenizer[]>;

  /** Get tokenizer metadata for a model */
  getTokenizerMetadata(model: string): Promise<TokenizerMetadata | null>;

  /** Batch count tokens for multiple texts */
  batchCountTokens(texts: string[], model: string): Promise<number[]>;

  /** Compare token counts across different tokenizers */
  compareTokenizers(text: string, model: string): Promise<TokenizerComparison[]>;
}

/**
 * Result of tokenizer comparison
 */
export interface TokenizerComparison {
  /** Tokenizer that was used */
  tokenizer: LocalTokenizer;

  /** Token count result */
  tokenCount: number;

  /** Time taken for tokenization (in milliseconds) */
  duration: number;

  /** Whether tokenization was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;
}

/**
 * Configuration for tokenizer preferences
 */
export interface TokenizerConfig {
  /** Default library preference */
  defaultLibrary?: string;

  /** Per-model tokenizer overrides */
  modelOverrides?: Record<string, TokenizerPreference>;

  /** Fallback tokenizer when none specified */
  fallbackTokenizer?: string;

  /** Whether to enable caching */
  enableCaching?: boolean;

  /** Cache TTL in milliseconds */
  cacheTtl?: number;
}

/**
 * Tokenizer preference for a specific model
 */
export interface TokenizerPreference {
  /** Preferred tokenizer ID */
  tokenizer: string;

  /** Preferred library */
  library: string;

  /** Priority (higher = more preferred) */
  priority?: number;
}

/**
 * Error types for tokenization operations
 */
export class TokenizationError extends Error {
  constructor(
    message: string,
    public tokenizerId: string,
    public model: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TokenizationError";
  }
}

export class TokenizerNotFoundError extends Error {
  constructor(
    message: string,
    public modelId: string,
    public requestedTokenizer?: string
  ) {
    super(message);
    this.name = "TokenizerNotFoundError";
  }
}

/**
 * Tokenization cache entry
 */
export interface TokenizationCacheEntry {
  /** Text that was tokenized */
  text: string;

  /** Model used for tokenization */
  model: string;

  /** Tokenizer used */
  tokenizerId: string;

  /** Token count result */
  tokenCount: number;

  /** When this entry was created */
  timestamp: Date;

  /** Hash of the text for quick lookup */
  textHash: string;
}
