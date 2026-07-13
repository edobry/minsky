/**
 * Tokenization Module Exports
 *
 * Main entry point for the tokenization infrastructure.
 * Provides access to all tokenization types, services, and implementations.
 */

// Core types and interfaces
export type {
  LocalTokenizer,
  TokenizerRegistry,
  TokenizerMetadata,
  TokenizationService,
  TokenizerComparison,
  TokenizerConfig,
  TokenizerPreference,
  TokenizationCacheEntry,
} from "./types";

// Error types
export { TokenizationError, TokenizerNotFoundError } from "./types";

// Tokenizer implementations
export { GptTokenizer } from "./gpt-tokenizer";
export { TiktokenTokenizer } from "./tiktoken-tokenizer";

// Registry and service
export { DefaultTokenizerRegistry } from "./registry";
export { DefaultTokenizationService } from "./service";

// Import classes for factory functions
import { DefaultTokenizerRegistry } from "./registry";
import { DefaultTokenizationService } from "./service";

// Factory function for easy initialization
export function createTokenizationService(): DefaultTokenizationService {
  const registry = new DefaultTokenizerRegistry();
  return new DefaultTokenizationService(registry);
}

// Factory function for registry with custom config
export function createTokenizerRegistry(
  config?: import("./types").TokenizerConfig
): DefaultTokenizerRegistry {
  return new DefaultTokenizerRegistry(config);
}
