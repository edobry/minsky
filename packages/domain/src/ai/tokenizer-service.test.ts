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

      // `source` was "fallback" here until mt#3928, and this assertion pinned
      // it. o200k_base IS gpt-4o's tokenizer — a detected match, not a
      // substitution — so the old expectation encoded the defect: the field
      // said "we had to guess" about the one family it never guesses for.
      expect(tokenizer).toEqual({
        encoding: "o200k_base",
        library: "gpt-tokenizer",
        source: "config",
      });
    });

    it("should detect gpt-4 tokenizer", async () => {
      const tokenizer = await service.getTokenizerInfo("gpt-4", "openai");

      expect(tokenizer).toEqual({
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "config",
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

  // -------------------------------------------------------------------------
  // mt#3370 — real-binding tests. Everything above exercises model->tokenizer
  // SELECTION and never loads the tokenizer library, which is why a broken
  // subpath survived: `createGptTokenizer` imported `gpt-tokenizer/cl100k_base`,
  // a v2 path that resolves to nothing under the declared v3, so every call
  // threw and callers silently degraded to a ~4-chars-per-token heuristic. The
  // whole suite passed throughout. These tests load the real library, so they
  // fail if the subpath breaks again.
  // -------------------------------------------------------------------------
  describe("real gpt-tokenizer binding (mt#3370)", () => {
    const EMBEDDING_MODEL = "text-embedding-3-small";

    it("actually tokenizes with the real library, not a heuristic", async () => {
      const tokens = await service.tokenize("hello world", EMBEDDING_MODEL, "openai");
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.every((t) => typeof t === "number")).toBe(true);
    });

    it("round-trips through detokenize", async () => {
      const text = "## Findings\n\n- `mt#2861` verdict: CLOSED\n";
      const tokens = await service.tokenize(text, EMBEDDING_MODEL, "openai");
      const back = await service.detokenize(tokens, EMBEDDING_MODEL, "openai");
      expect(back).toBe(text);
    });

    it("counts dense markdown well above 4 chars/token — the assumption the fallback made", async () => {
      // The old fallback assumed ~4 chars/token and capped input by character
      // count. Real dense markdown measures ~2.8, so a 32,000-char cap was
      // ~11.3k tokens against an 8,192 limit — which is how mt#2861 kept being
      // rejected by OpenAI even after "truncation".
      const block =
        "## Findings\n\n- **mt#2861** — `close/subsume` verdict, see `packages/domain/src/tasks/x.ts:152`.\n";
      let content = "";
      while (content.length < 8000) content += block;
      const tokens = await service.tokenize(content, EMBEDDING_MODEL, "openai");
      const charsPerToken = content.length / tokens.length;
      expect(charsPerToken).toBeLessThan(4);
    });

    it("o200k_base loads too — the same subpath shape", async () => {
      const tokens = await service.tokenize("hello world", "gpt-4o", "openai");
      expect(tokens.length).toBeGreaterThan(0);
    });
  });
});
