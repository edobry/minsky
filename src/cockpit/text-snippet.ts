/**
 * Markdown-stripped display snippet helper (mt#2770 — conversation labeling).
 *
 * Turns raw first-user-turn text (which may contain markdown, code fences,
 * links, etc.) into a short, plain-text label suitable for a list row or a
 * page header. Deliberately NOT a full markdown parser — just enough
 * pattern-stripping to keep common syntax from leaking into the label, with
 * a hard length cap and word-boundary-aware truncation.
 *
 * mt#2784 adds harness-wrapper stripping ({@link stripHarnessMarkup}), run
 * BEFORE markdown-stripping in {@link toDisplaySnippet}: a slash-command or
 * hook-injected turn's `<command-message>`/`<command-name>`/
 * `<local-command-stdout>`/`<system-reminder>` blocks are harness structural
 * markup, not operator prose, so the whole block (tag markers AND contained
 * text) is discarded — the same "discard the block" treatment already
 * applied to fenced code above, not a partial unwrap.
 */
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Harness-injected structural wrapper tags whose CONTENTS are never operator
 * prose (mt#2784). `<command-message>` is a deliberate judgment call, not an
 * oversight: its body is just the invoked skill/command's display name (e.g.
 * "error-handling"), which reads like plausible label text — but it is
 * harness boilerplate the operator never typed, so it is discarded entirely
 * along with the other three tags rather than unwrapped (contrast with a
 * markdown link, where the visible text IS operator-authored and is kept).
 */
const HARNESS_WRAPPER_TAGS = [
  "command-message",
  "command-name",
  "local-command-stdout",
  "system-reminder",
] as const;

/**
 * Strip harness command-wrapper / system-reminder blocks — tag markers AND
 * everything between them, discarded as a single unit (mt#2784). Applied
 * BEFORE {@link stripMarkdown} in {@link toDisplaySnippet} so a slash-command
 * turn like `<command-message>error-handling</command-message>` reduces to
 * an empty string rather than leaking raw XML into a label.
 */
export function stripHarnessMarkup(text: string): string {
  let s = text;
  for (const tag of HARNESS_WRAPPER_TAGS) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
    s = s.replace(re, " ");
  }
  return s;
}

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
  const stripped = stripMarkdown(stripHarnessMarkup(text));
  if (!stripped) return "";
  return truncateSnippet(stripped, maxLen);
}
