/**
 * Tiktoken Tokenizer Implementation
 *
 * Wrapper for the tiktoken library providing LocalTokenizer interface.
 * JavaScript port of OpenAI's official tiktoken library.
 */

import { get_encoding, encoding_for_model } from "tiktoken";
import type { LocalTokenizer } from "./types";

/**
 * Tiktoken implementation using tiktoken library
 */
export class TiktokenTokenizer implements LocalTokenizer {
  readonly id = "tiktoken";
  readonly name = "Tiktoken";
  readonly library = "tiktoken";

  // Models supported by tiktoken library
  readonly supportedModels = [
    "gpt-4",
    "gpt-4-0314",
    "gpt-4-0613",
    "gpt-4-32k",
    "gpt-4-32k-0314",
    "gpt-4-32k-0613",
    "gpt-4-turbo",
    "gpt-4-turbo-preview",
    "gpt-4-1106-preview",
    "gpt-4-0125-preview",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
    "text-davinci-003",
    "text-davinci-002",
    "text-davinci-001",
    "davinci",
    "curie",
    "babbage",
    "ada",
  ];

  /**
   * Encode text to tokens
   */
  encode(text: string, model?: string): number[] {
    try {
      if (model && this.isModelSupported(model)) {
        const encoding = encoding_for_model(model as any);
        const tokens = encoding.encode(text);
        encoding.free(); // Important: free the encoding to prevent memory leaks
        return Array.from(tokens);
      } else {
        // Fall back to cl100k_base encoding for unknown models
        const encoding = get_encoding("cl100k_base");
        const tokens = encoding.encode(text);
        encoding.free();
        return Array.from(tokens);
      }
    } catch (error) {
      throw new Error(`Failed to encode text with tiktoken: ${error}`);
    }
  }

  /**
   * Decode tokens to text
   */
  decode(tokens: number[], model?: string): string {
    try {
      if (model && this.isModelSupported(model)) {
        const encoding = encoding_for_model(model as any);
        const decoded = encoding.decode(new Uint32Array(tokens));
        encoding.free();
        return new TextDecoder().decode(decoded);
      } else {
        const encoding = get_encoding("cl100k_base");
        const decoded = encoding.decode(new Uint32Array(tokens));
        encoding.free();
        return new TextDecoder().decode(decoded);
      }
    } catch (error) {
      throw new Error(`Failed to decode tokens with tiktoken: ${error}`);
    }
  }

  /**
   * Count tokens in text (optimized)
   */
  countTokens(text: string, model?: string): number {
    try {
      if (model && this.isModelSupported(model)) {
        const encoding = encoding_for_model(model as any);
        const tokens = encoding.encode(text);
        const count = tokens.length;
        encoding.free();
        return count;
      } else {
        const encoding = get_encoding("cl100k_base");
        const tokens = encoding.encode(text);
        const count = tokens.length;
        encoding.free();
        return count;
      }
    } catch (error) {
      throw new Error(`Failed to count tokens with tiktoken: ${error}`);
    }
  }

  /**
   * Check if model is supported
   */
  supportsModel(model: string): boolean {
    return this.isModelSupported(model);
  }

  /**
   * Internal method to check model support
   */
  private isModelSupported(model: string): boolean {
    // Direct model support
    if (this.supportedModels.includes(model)) {
      return true;
    }

    // Pattern matching for model variants
    const modelPatterns = [
      /^gpt-4(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4-turbo(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-3\.5-turbo(-\d{4}-\d{2}-\d{2})?$/,
    ];

    return modelPatterns.some((pattern) => pattern.test(model));
  }

  /**
   * Get the encoding name for a model
   */
  getEncodingForModel(model: string): string {
    try {
      if (this.isModelSupported(model)) {
        // For known models, tiktoken can determine the encoding
        if (model.startsWith("gpt-4o")) {
          return "o200k_base";
        } else if (model.startsWith("gpt-4") || model.startsWith("gpt-3.5-turbo")) {
          return "cl100k_base";
        } else if (
          model.includes("davinci") ||
          model.includes("curie") ||
          model.includes("babbage") ||
          model.includes("ada")
        ) {
          return "p50k_base";
        }
      }

      // Default fallback
      return "cl100k_base";
    } catch (error) {
      return "cl100k_base";
    }
  }

  /**
   * Get available encodings
   */
  getAvailableEncodings(): string[] {
    return [
      "o200k_base", // GPT-4o models
      "cl100k_base", // GPT-4, GPT-3.5-turbo models
      "p50k_base", // Legacy models
      "r50k_base", // GPT-3 models
    ];
  }
}
