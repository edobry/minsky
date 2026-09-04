import { describe, it, expect } from "bun:test";
import { buildExcerpt, hasStoredExcerpt, EXCERPT_MAX_CHARS } from "./excerpt";

describe("buildExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(buildExcerpt("A short chunk.")).toBe("A short chunk.");
  });

  it("collapses whitespace runs into single spaces", () => {
    const chunk = "## Heading\n\nFirst paragraph.\n\n\nSecond   paragraph.\n";
    expect(buildExcerpt(chunk)).toBe("## Heading First paragraph. Second paragraph.");
  });

  it("returns an empty string for empty or whitespace-only text", () => {
    expect(buildExcerpt("")).toBe("");
    expect(buildExcerpt("   \n\n\t ")).toBe("");
  });

  it("backs off to a word boundary rather than cutting mid-word", () => {
    const chunk = "alpha bravo charlie delta echo foxtrot";
    // A 30-char cap slices mid-"echo"; the boundary at 25 is within tolerance,
    // so the partial word is dropped instead of shipped.
    const excerpt = buildExcerpt(chunk, 30);

    expect(excerpt).toBe("alpha bravo charlie delta…");
    expect(excerpt).not.toContain("ech");
  });

  it("never exceeds maxChars, including the ellipsis", () => {
    const chunk = "word ".repeat(500);
    for (const cap of [1, 2, 10, 37, 200, EXCERPT_MAX_CHARS]) {
      expect(buildExcerpt(chunk, cap).length).toBeLessThanOrEqual(cap);
    }
  });

  it("hard-cuts a single unbroken token rather than discarding most of the excerpt", () => {
    // A URL-shaped chunk has no space to back off to within tolerance.
    const chunk = `https://example.com/${"x".repeat(200)}`;
    const excerpt = buildExcerpt(chunk, 40);

    expect(excerpt.length).toBe(40);
    expect(excerpt.startsWith("https://example.com/")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("keeps a late word boundary but hard-cuts an early one", () => {
    // The only space sits at index 2 — far below the 80% tolerance floor for a
    // 30-char cap, so backing off to it would throw away most of the excerpt.
    const excerpt = buildExcerpt(`ab ${"c".repeat(200)}`, 30);
    expect(excerpt.length).toBe(30);
    expect(excerpt.startsWith("ab ccc")).toBe(true);
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(buildExcerpt("anything at all", 0)).toBe("");
    expect(buildExcerpt("anything at all", -5)).toBe("");
  });

  it("defaults to EXCERPT_MAX_CHARS", () => {
    const chunk = "word ".repeat(1000);
    expect(buildExcerpt(chunk)).toEqual(buildExcerpt(chunk, EXCERPT_MAX_CHARS));
    expect(buildExcerpt(chunk).length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
  });
});

describe("hasStoredExcerpt", () => {
  it("is false when no indexer ever wrote the key", () => {
    expect(hasStoredExcerpt({ contentHash: "abc", title: "T" })).toBe(false);
  });

  it("is true for a written excerpt", () => {
    expect(hasStoredExcerpt({ excerpt: "some preview text" })).toBe(true);
  });

  it("is true for a legitimately empty excerpt, so an empty document is not re-indexed forever", () => {
    // An empty document chunks to one empty chunk; its excerpt is "" by right.
    expect(hasStoredExcerpt({ excerpt: "" })).toBe(true);
  });

  it("is false when the key holds a non-string", () => {
    expect(hasStoredExcerpt({ excerpt: null })).toBe(false);
    expect(hasStoredExcerpt({ excerpt: 42 })).toBe(false);
  });
});
