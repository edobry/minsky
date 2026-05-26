/**
 * GPT Tokenizer Implementation
 *
 * Wrapper for the gpt-tokenizer library providing LocalTokenizer interface.
 * Optimized for OpenAI models with high performance BPE tokenization.
 */

import { encode, decode, encodeChat } from "gpt-tokenizer";
import type { LocalTokenizer } from "./types";

/**
 * GPT Tokenizer implementation using gpt-tokenizer library
 */
export class GptTokenizer implements LocalTokenizer {
  readonly id = "gpt-tokenizer";
  readonly name = "GPT Tokenizer";
  readonly library = "gpt-tokenizer";

  // Models supported by gpt-tokenizer library
  readonly supportedModels = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4o-2024-11-20",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-05-13",
    "gpt-4o-mini-2024-07-18",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-turbo-preview",
    "gpt-4-0125-preview",
    "gpt-4-1106-preview",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-0314",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
    "text-davinci-003",
    "text-davinci-002",
    "text-davinci-001",
    "davinci",
    "curie",
    "babbage",
    "ada",
    // o1 models
    "o1-preview",
    "o1-preview-2024-09-12",
    "o1-mini",
    "o1-mini-2024-09-12",
    // o3 models (when available)
    "o3",
    "o3-mini",
  ];

  /**
   * Encode text to tokens
   */
  encode(text: string, model?: string): number[] {
    try {
      return encode(text);
    } catch (error) {
      throw new Error(`Failed to encode text with gpt-tokenizer: ${error}`);
    }
  }

  /**
   * Decode tokens to text
   */
  decode(tokens: number[], model?: string): string {
    try {
      return decode(tokens);
    } catch (error) {
      throw new Error(`Failed to decode tokens with gpt-tokenizer: ${error}`);
    }
  }

  /**
   * Count tokens in text (optimized)
   */
  countTokens(text: string, model?: string): number {
    try {
      // gpt-tokenizer's encode function is optimized for token counting
      return this.encode(text, model).length;
    } catch (error) {
      throw new Error(`Failed to count tokens with gpt-tokenizer: ${error}`);
    }
  }

  /**
   * Check if model is supported
   */
  supportsModel(model: string): boolean {
    // Support exact matches and common patterns
    if (this.supportedModels.includes(model)) {
      return true;
    }

    // Support model variants (e.g., gpt-4o-2024-xx-xx patterns)
    const modelPatterns = [
      /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4(-turbo)?(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-3\.5-turbo(-\d{4}-\d{2}-\d{2})?$/,
      /^o1(-preview|-mini)?(-\d{4}-\d{2}-\d{2})?$/,
      /^o3(-mini)?(-\d{4}-\d{2}-\d{2})?$/,
    ];

    return modelPatterns.some((pattern) => pattern.test(model));
  }

  /**
   * Get the tokenizer encoding for a model
   */
  getModelEncoding(model?: string): string {
    if (!model) {
      return "o200k_base"; // Default for latest models
    }

    // Map models to their encodings
    if (model.startsWith("gpt-4o") || model.startsWith("o1") || model.startsWith("o3")) {
      return "o200k_base";
    }

    if (model.startsWith("gpt-4") || model.startsWith("gpt-3.5-turbo")) {
      return "cl100k_base";
    }

    if (
      model.includes("davinci") ||
      model.includes("curie") ||
      model.includes("babbage") ||
      model.includes("ada")
    ) {
      return "p50k_base";
    }

    // Default to most recent encoding
    return "o200k_base";
  }

  /**
   * Count tokens for chat messages format
   */
  countChatTokens(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    model?: string
  ): number {
    try {
      return encodeChat(messages).length;
    } catch (error) {
      throw new Error(`Failed to count chat tokens with gpt-tokenizer: ${error}`);
    }
  }
}
