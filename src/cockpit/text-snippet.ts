/**
 * Markdown-stripped display snippet helper (mt#2770 — conversation labeling).
 *
 * Turns raw first-user-turn text (which may contain markdown, code fences,
 * links, etc.) into a short, plain-text label suitable for a list row or a
 * page header. Deliberately NOT a full markdown parser — just enough
 * pattern-stripping to keep common syntax from leaking into the label, with
 * a hard length cap and word-boundary-aware truncation.
 */
import { safeTruncate } from "@minsky/shared/safe-truncate";

/** Strip common markdown syntax, collapsing the result to a single line. */
export function stripMarkdown(text: string): string {
  let s = text;

  // Code fences: strip the whole block (fence markers AND contained text) to
  // a single placeholder space — a code block rarely reads as a useful label
  // fragment. Inline code: keep the contained text, drop only the backtick
  // markers.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");

  // Images and links: ![alt](url) -> alt ; [text](url) -> text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Heading / blockquote / list markers at line start.
  s = s.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "");

  // Emphasis markers (bold/italic), non-greedy.
  s = s.replace(/(\*\*\*|___)([^*_]+)\1/g, "$2");
  s = s.replace(/(\*\*|__)([^*_]+)\1/g, "$2");
  s = s.replace(/(\*|_)([^*_]+)\1/g, "$2");

  // Collapse all whitespace (including newlines) to single spaces.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Truncate a plain-text string to at most `maxLen` characters, preferring a
 * word boundary and appending an ellipsis when truncated. Never throws.
 */
export function truncateSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // safeTruncate avoids splitting a UTF-16 surrogate pair (custom/no-unsafe-string-truncation).
  const cut = safeTruncate(text, maxLen, "head");
  const lastSpace = cut.lastIndexOf(" ");
  // Only break at the word boundary if it doesn't throw away too much text.
  const base = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/**
 * Convenience wrapper: strip markdown then truncate. Returns `""` for
 * null/undefined/empty input so callers can treat it as "no snippet" without
 * a separate null check.
 */
export function toDisplaySnippet(text: string | null | undefined, maxLen: number): string {
  if (!text) return "";
  const stripped = stripMarkdown(text);
  if (!stripped) return "";
  return truncateSnippet(stripped, maxLen);
}
