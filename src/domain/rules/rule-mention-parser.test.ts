import { describe, it, expect } from "bun:test";
import { extractRuleMentions, hasRuleMentions, stripRuleMentions } from "./rule-mention-parser";

describe("Rule Mention Parser", () => {
  describe("extractRuleMentions", () => {
    it("should extract single @ruleName mention", () => {
      const query = "Please help me with @testing-boundaries when writing tests";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["testing-boundaries"]);
    });

    it("should extract multiple @ruleName mentions", () => {
      const query = "Use @error-handling and @robust-error-handling for this fix";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["error-handling", "robust-error-handling"]);
    });

    it("should handle @ruleName at start, middle, and end", () => {
      const query = "@start-rule in the middle @middle-rule at end @end-rule";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["start-rule", "middle-rule", "end-rule"]);
    });

    it("should handle rule names with underscores and hyphens", () => {
      const query = "Apply @test_driven_development and @session-first-workflow";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["test_driven_development", "session-first-workflow"]);
    });

    it("should deduplicate mentioned rule names", () => {
      const query = "Use @testing-boundaries twice: @testing-boundaries again";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["testing-boundaries"]);
    });

    it("should return empty array for query with no mentions", () => {
      const query = "Just regular text without any mentions";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual([]);
    });

    it("should return empty array for empty or null query", () => {
      expect(extractRuleMentions("")).toEqual([]);
      expect(extractRuleMentions("   ")).toEqual([]);
      expect(extractRuleMentions(null as any)).toEqual([]);
      expect(extractRuleMentions(undefined as any)).toEqual([]);
    });

    it("should not match @ symbols that aren't rule mentions", () => {
      const query = "Email john@example.com and check @valid-rule but ignore user@domain.org";
      const mentions = extractRuleMentions(query);
      
      expect(mentions).toEqual(["valid-rule"]);
    });
  });

  describe("hasRuleMentions", () => {
    it("should return true when query contains @ruleName", () => {
      expect(hasRuleMentions("Use @testing-boundaries here")).toBe(true);
      expect(hasRuleMentions("@start-rule at beginning")).toBe(true);
      expect(hasRuleMentions("At end @end-rule")).toBe(true);
    });

    it("should return false when query has no @ruleName mentions", () => {
      expect(hasRuleMentions("Just regular text")).toBe(false);
      expect(hasRuleMentions("Email user@domain.com")).toBe(false);
      expect(hasRuleMentions("")).toBe(false);
    });
  });

  describe("stripRuleMentions", () => {
    it("should remove @ruleName mentions and clean whitespace", () => {
      const query = "Use @testing-boundaries when writing tests @error-handling";
      const stripped = stripRuleMentions(query);
      
      expect(stripped).toBe("Use when writing tests");
    });

    it("should handle mentions at start and end", () => {
      const query = "@start-rule help me with this task @end-rule";
      const stripped = stripRuleMentions(query);
      
      expect(stripped).toBe("help me with this task");
    });

    it("should preserve non-mention @ symbols", () => {
      const query = "Email john@example.com about @testing-boundaries rule";
      const stripped = stripRuleMentions(query);
      
      expect(stripped).toBe("Email john@example.com about rule");
    });

    it("should handle multiple consecutive mentions", () => {
      const query = "@first-rule @second-rule @third-rule help me";
      const stripped = stripRuleMentions(query);
      
      expect(stripped).toBe("help me");
    });

    it("should return empty string for mentions-only query", () => {
      const query = "@rule-one @rule-two @rule-three";
      const stripped = stripRuleMentions(query);
      
      expect(stripped).toBe("");
    });

    it("should handle empty or null input", () => {
      expect(stripRuleMentions("")).toBe("");
      expect(stripRuleMentions("   ")).toBe("");
      expect(stripRuleMentions(null as any)).toBe("");
      expect(stripRuleMentions(undefined as any)).toBe("");
    });
  });
});
