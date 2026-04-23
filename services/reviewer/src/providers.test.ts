import { describe, expect, test } from "bun:test";
import { isReasoningModel } from "./providers";

describe("isReasoningModel", () => {
  describe("o-series reasoning models", () => {
    test("accepts o1 variants", () => {
      expect(isReasoningModel("o1")).toBe(true);
      expect(isReasoningModel("o1-mini")).toBe(true);
      expect(isReasoningModel("o1-preview")).toBe(true);
    });

    test("accepts o3 variants", () => {
      expect(isReasoningModel("o3")).toBe(true);
      expect(isReasoningModel("o3-mini")).toBe(true);
    });

    test("accepts o4 variants", () => {
      expect(isReasoningModel("o4")).toBe(true);
      expect(isReasoningModel("o4-mini")).toBe(true);
    });
  });

  describe("gpt-5 family", () => {
    test("accepts plain gpt-5", () => {
      expect(isReasoningModel("gpt-5")).toBe(true);
    });

    test("accepts gpt-5 variants", () => {
      expect(isReasoningModel("gpt-5-turbo")).toBe(true);
      expect(isReasoningModel("gpt-5-mini")).toBe(true);
    });
  });

  describe("non-reasoning models (must return false)", () => {
    test("rejects gpt-4o family", () => {
      expect(isReasoningModel("gpt-4o")).toBe(false);
      expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    });

    test("rejects gpt-4 family", () => {
      expect(isReasoningModel("gpt-4")).toBe(false);
      expect(isReasoningModel("gpt-4-turbo")).toBe(false);
    });

    test("rejects gpt-3.5 family", () => {
      expect(isReasoningModel("gpt-3.5-turbo")).toBe(false);
    });

    test("rejects non-OpenAI-prefixed names", () => {
      expect(isReasoningModel("claude-opus-4")).toBe(false);
      expect(isReasoningModel("gemini-2.5-pro")).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("rejects empty string", () => {
      expect(isReasoningModel("")).toBe(false);
    });

    test("rejects names that start with a letter but not the o-series pattern", () => {
      // "open-mistral" or similar — starts with "o" but not "o<digit>"
      expect(isReasoningModel("open-mistral-7b")).toBe(false);
      expect(isReasoningModel("other-model")).toBe(false);
    });

    test("does not match gpt-5 as a substring of a longer name (boundary check)", () => {
      // "gpt-50-turbo" is hypothetical but a boundary concern
      expect(isReasoningModel("gpt-50")).toBe(false);
      expect(isReasoningModel("gpt-55-turbo")).toBe(false);
    });
  });
});
