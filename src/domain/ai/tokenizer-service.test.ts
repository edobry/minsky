/**
 * Tests for TokenizerService
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { DefaultTokenizerService } from "./tokenizer-service";
import type { TokenizerInfo } from "./types";

describe("DefaultTokenizerService", () => {
  let service: DefaultTokenizerService;

  beforeEach(() => {
    service = new DefaultTokenizerService();
  });

  describe("getTokenizerInfo", () => {
    it("should detect gpt-4o tokenizer", async () => {
      const tokenizer = await service.getTokenizerInfo("gpt-4o", "openai");

      expect(tokenizer).toEqual({
        encoding: "o200k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      });
    });

    it("should detect gpt-4 tokenizer", async () => {
      const tokenizer = await service.getTokenizerInfo("gpt-4", "openai");

      expect(tokenizer).toEqual({
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      });
    });

    it("should detect claude tokenizer", async () => {
      const tokenizer = await service.getTokenizerInfo("claude-3-5-sonnet-20241022", "anthropic");

      expect(tokenizer).toEqual({
        encoding: "claude-3",
        library: "anthropic",
        source: "fallback",
      });
    });

    it("should detect gemini tokenizer", async () => {
      const tokenizer = await service.getTokenizerInfo("gemini-1.5-pro", "google");

      expect(tokenizer).toEqual({
        encoding: "gemini",
        library: "google",
        source: "fallback",
      });
    });

    it("should use custom registered tokenizer", async () => {
      const customTokenizer: TokenizerInfo = {
        encoding: "custom-encoding",
        library: "custom",
        source: "config",
      };

      service.registerTokenizer("custom-model", customTokenizer);
      const result = await service.getTokenizerInfo("custom-model");

      expect(result).toEqual(customTokenizer);
    });
  });

  describe("getFallbackTokenizer", () => {
    it("should return OpenAI fallback", () => {
      const fallback = service.getFallbackTokenizer("openai");

      expect(fallback).toEqual({
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      });
    });

    it("should return Anthropic fallback", () => {
      const fallback = service.getFallbackTokenizer("anthropic");

      expect(fallback).toEqual({
        encoding: "claude-3",
        library: "anthropic",
        source: "fallback",
      });
    });

    it("should return Google fallback", () => {
      const fallback = service.getFallbackTokenizer("google");

      expect(fallback).toEqual({
        encoding: "gemini",
        library: "google",
        source: "fallback",
      });
    });

    it("should return default fallback for unknown provider", () => {
      const fallback = service.getFallbackTokenizer("unknown");

      expect(fallback).toEqual({
        encoding: "cl100k_base",
        library: "tiktoken",
        source: "fallback",
      });
    });
  });

  describe("model pattern detection", () => {
    it("should detect O1 models", async () => {
      const tokenizer = await service.getTokenizerInfo("o1-preview");

      expect(tokenizer?.encoding).toBe("o200k_base");
      expect(tokenizer?.library).toBe("gpt-tokenizer");
    });

    it("should detect GPT-3.5 models", async () => {
      const tokenizer = await service.getTokenizerInfo("gpt-3.5-turbo");

      expect(tokenizer?.encoding).toBe("cl100k_base");
      expect(tokenizer?.library).toBe("gpt-tokenizer");
    });

    it("should detect any Claude model", async () => {
      const tokenizer = await service.getTokenizerInfo("claude-2.1");

      expect(tokenizer?.encoding).toBe("claude-3");
      expect(tokenizer?.library).toBe("anthropic");
    });

    it("should detect any Gemini model", async () => {
      const tokenizer = await service.getTokenizerInfo("gemini-1.5-flash");

      expect(tokenizer?.encoding).toBe("gemini");
      expect(tokenizer?.library).toBe("google");
    });
  });

  describe("countTokens", () => {
    it("should throw error for unsupported model", async () => {
      expect(async () => {
        await service.countTokens("test text", "unsupported-model");
      }).toThrow("No tokenizer found for model: unsupported-model");
    });

    // Note: We can't easily test actual tokenization without mocking the libraries
    // since gpt-tokenizer and tiktoken require setup. These would be integration tests.
  });
});
