/**
 * Content Chunker
 *
 * Splits markdown content into chunks that fit within the embedding token limit.
 * Uses a hierarchical splitting strategy: headings → paragraphs → tokens.
 */

export interface ChunkResult {
  chunks: string[];
  strategy: "headings" | "paragraphs" | "tokens";
}

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Approximate token count using the ~4 chars per token heuristic for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split content into token-sized chunks as a last resort.
 */
function splitByTokens(content: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) {
    return [content];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    chunks.push(content.slice(start, start + maxChars));
    start += maxChars;
  }
  return chunks;
}

/**
 * Split content on paragraph boundaries (double newlines).
 */
function splitByParagraphs(content: string, maxTokens: number): string[] {
  const paragraphs = content.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
      }
      // If single paragraph exceeds limit, split by tokens
      if (estimateTokens(paragraph) > maxTokens) {
        const tokenChunks = splitByTokens(paragraph, maxTokens);
        chunks.push(...tokenChunks);
        current = "";
      } else {
        current = paragraph;
      }
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Result of splitting a section by ### subheadings.
 */
interface SubheadingResult {
  chunks: string[];
  usedParagraphs: boolean;
}

/**
 * Split a section by ### headings (level 3).
 * If still too large, falls back to paragraph splitting.
 */
function splitSectionBySubheadings(section: string, maxTokens: number): SubheadingResult {
  const parts = section.split(/(?=^### )/m);
  const chunks: string[] = [];
  let usedParagraphs = false;

  for (const part of parts) {
    if (estimateTokens(part) <= maxTokens) {
      if (part.trim()) {
        chunks.push(part.trim());
      }
    } else {
      // Fall back to paragraph splitting for this subsection
      usedParagraphs = true;
      chunks.push(...splitByParagraphs(part, maxTokens));
    }
  }

  return { chunks: chunks.filter((c) => c.length > 0), usedParagraphs };
}

/**
 * Split markdown content into chunks that fit within the token limit.
 *
 * Strategy:
 * 1. Split on ## headings (level 2)
 * 2. If a section is too large, split on ### headings within it
 * 3. If still too large, split on paragraph boundaries
 * 4. If a single paragraph is too large, split by token count
 *
 * Each chunk retains its heading context.
 */
export function chunkContent(content: string, maxTokens: number = DEFAULT_MAX_TOKENS): ChunkResult {
  // If the entire content fits, return as-is
  if (estimateTokens(content) <= maxTokens) {
    return { chunks: [content], strategy: "headings" };
  }

  // Split on ## headings (level 2)
  const sections = content.split(/(?=^## )/m);
  const allFitInHeadings = sections.every((s) => estimateTokens(s) <= maxTokens);

  if (allFitInHeadings) {
    const chunks = sections.filter((s) => s.trim().length > 0).map((s) => s.trim());
    return { chunks, strategy: "headings" };
  }

  // Some sections are too large; try ### subheadings
  const headingChunks: string[] = [];
  let usedParagraphsInSubheadings = false;

  for (const section of sections) {
    if (!section.trim()) continue;

    if (estimateTokens(section) <= maxTokens) {
      headingChunks.push(section.trim());
    } else {
      const result = splitSectionBySubheadings(section, maxTokens);
      headingChunks.push(...result.chunks);
      if (result.usedParagraphs) {
        usedParagraphsInSubheadings = true;
      }
    }
  }

  // If subheading/paragraph splitting produced fitting chunks, return them
  const allFit = headingChunks.every((c) => estimateTokens(c) <= maxTokens);
  if (allFit) {
    return {
      chunks: headingChunks,
      strategy: usedParagraphsInSubheadings ? "paragraphs" : "headings",
    };
  }

  // Fall back to paragraph-based splitting
  const paragraphChunks: string[] = [];
  let usedTokens = false;

  for (const chunk of headingChunks) {
    if (estimateTokens(chunk) <= maxTokens) {
      paragraphChunks.push(chunk);
    } else {
      const subChunks = splitByParagraphs(chunk, maxTokens);
      paragraphChunks.push(...subChunks);
      // Check if any token splitting occurred
      if (subChunks.some((c) => estimateTokens(c) > maxTokens)) {
        usedTokens = true;
      }
    }
  }

  return {
    chunks: paragraphChunks.filter((c) => c.length > 0),
    strategy: usedTokens ? "tokens" : "paragraphs",
  };
}
