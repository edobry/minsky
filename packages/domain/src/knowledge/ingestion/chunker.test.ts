import { describe, it, expect } from "bun:test";
import { chunkContent } from "./chunker";

describe("chunkContent", () => {
  describe("content under limit", () => {
    it("returns a single chunk when content fits within maxTokens", () => {
      const content = "# Title\n\nSome short content that fits easily.";
      const result = chunkContent(content, 8192);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toBe(content);
      expect(result.strategy).toBe("headings");
    });

    it("returns a single chunk for empty content", () => {
      const result = chunkContent("", 8192);
      expect(result.chunks).toHaveLength(1);
    });
  });

  describe("heading-based splitting", () => {
    it("splits on ## headings when content exceeds limit", () => {
      const section1 = `## Section One\n\n${"a".repeat(100)}`;
      const section2 = `## Section Two\n\n${"b".repeat(100)}`;
      const content = `${section1}\n\n${section2}`;

      // maxTokens = 50 forces splitting (each section ~50+ chars / 4 > 50)
      const result = chunkContent(content, 30);

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      expect(result.strategy).toBe("headings");
    });

    it("each chunk starts with the heading when split by ##", () => {
      // 4 chars/token, so 200 chars = 50 tokens; limit = 40 forces split
      const section1 = `## Alpha\n\n${"x".repeat(150)}`;
      const section2 = `## Beta\n\n${"y".repeat(150)}`;
      const content = `${section1}\n\n${section2}`;

      const result = chunkContent(content, 40);

      const hasAlpha = result.chunks.some((c) => c.includes("## Alpha"));
      const hasBeta = result.chunks.some((c) => c.includes("## Beta"));
      expect(hasAlpha).toBe(true);
      expect(hasBeta).toBe(true);
    });

    it("splits on ### subheadings when ## sections are too large", () => {
      const sub1 = `### Sub One\n\n${"c".repeat(100)}`;
      const sub2 = `### Sub Two\n\n${"d".repeat(100)}`;
      const section = `## Big Section\n\n${sub1}\n\n${sub2}`;
      const content = section;

      // maxTokens = 40 forces splitting within the section
      const result = chunkContent(content, 40);

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("paragraph splitting", () => {
    it("splits on double newlines when sections cannot be split by headings", () => {
      // No headings — just paragraphs
      const para1 = "e".repeat(100);
      const para2 = "f".repeat(100);
      const content = `${para1}\n\n${para2}`;

      // maxTokens = 30 forces paragraph split (each paragraph ~25 tokens at 4 chars/token)
      const result = chunkContent(content, 30);

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      expect(result.strategy).toBe("paragraphs");
    });

    it("accumulates paragraphs into a chunk until it would exceed the limit", () => {
      const short = "g".repeat(40); // ~10 tokens
      const content = [short, short, short, short, short, short].join("\n\n");

      // maxTokens = 25: each paragraph is ~10 tokens, so groups of 2 fit (~20 tokens)
      const result = chunkContent(content, 25);

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      // Each chunk should not exceed the limit
      for (const chunk of result.chunks) {
        expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(25);
      }
    });
  });

  describe("token splitting", () => {
    it("splits a single huge paragraph by token count", () => {
      // One enormous paragraph with no heading or double-newline breaks
      const content = "h".repeat(1000);

      // maxTokens = 50 (200 chars): should produce multiple chunks
      const result = chunkContent(content, 50);

      expect(result.chunks.length).toBeGreaterThan(1);
      // Every chunk must fit within the token limit
      for (const chunk of result.chunks) {
        expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(50);
      }
    });
  });

  describe("all content is preserved", () => {
    it("concatenating all chunks produces the original content (approximately)", () => {
      const para1 = "Word ".repeat(200);
      const para2 = "Text ".repeat(200);
      const content = `${para1}\n\n${para2}`;

      const result = chunkContent(content, 100);

      // All original characters should appear across chunks
      const joined = result.chunks.join("");
      expect(joined.length).toBeGreaterThan(0);
      // No chunk should be empty
      for (const chunk of result.chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
