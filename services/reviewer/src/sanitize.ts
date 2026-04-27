/**
 * Post-process the reviewer model's raw output before posting to GitHub.
 *
 * Reasoning-heavy models (observed on `openai:gpt-5`) can occasionally leak
 * internal chain-of-thought scratch into the visible output. On PR #743
 * (2026-04-24) the reviewer posted a body that opened with pages of "I will
 * read the file...", "Calling read_file on src/domain/ai/types.ts.", "Go.",
 * "This time for sure." and hundreds of blank lines before the actual
 * `Findings` section.
 *
 * This module detects that pattern structurally and either strips the
 * prefix (when a recognisable review body follows) or replaces the whole
 * output with a structured error notice (when the leak is the entire body).
 *
 * Sibling reliability concern: empty model output (mt#1125) is handled in
 * `review-worker.ts` directly as an early return — a different failure class.
 *
 * See: docs/architecture/critic-constitution-reliability.md
 * Task: mt#1212
 */

export type SanitizeAction = "passthrough" | "stripped" | "errored";

export interface SanitizeResult {
  action: SanitizeAction;
  body: string;
  meta: {
    originalLength: number;
    cleanedLength: number;
    // Joined signal list when action !== "passthrough", e.g. "blank-line-run,scratch:go-dot".
    reason?: string;
  };
}

// Recognisable top-level headings the Critic Constitution prompt asks the
// model to emit. `#`..`######` or a bold **Heading** both match.
// Note: we intentionally use `[ \t]*` (not `\s*`) so the regex doesn't
// greedily consume newlines before the heading — that would truncate the
// prefix we scan for CoT signals and make blank-line-run detection miss.
// Exported so calibration tooling (services/reviewer/scripts/calibrate-tolerance.ts)
// can reuse the canonical pattern instead of duplicating it (mt#1264 R1 BLOCKING fix).
export const STRUCTURAL_HEADING_RE =
  /^[ \t]*(?:#{1,6}[ \t]+|\*\*)(findings|spec verification|summary|documentation impact)\b/im;

// "Strong" scratch patterns — each one alone is enough to fire the heuristic.
// These are phrases a well-formed review body never contains at the top.
//
// Apostrophe character classes include both ASCII `'` (U+0027) and the
// typographic curly apostrophe `’` — GPT-5 often emits the curly form
// in prose, and the PR #758 R3 reviewer flagged the ASCII-only variants as
// a gap.
const STRONG_SCRATCH_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // "Calling read_file on src/foo.ts." / "Calling list_directory" —
  //
  // Two alternatives — either the tool name is snake_case (contains an
  // underscore), OR the call includes an `on <path>` segment. Keeps real
  // tool-call narration captured while excluding prose like
  // "Calling maintainers," or "Calling this." Trailing punctuation is
  // optional so "Calling read_file\n" (no period, just a newline) also
  // matches — R5 reviewer flagged the stricter form as a recall gap.
  {
    pattern: /\bCalling\s+(?:[a-z_][a-z_0-9]*_[a-z_0-9]+|[a-z_][a-z_0-9]*\s+on\s+\S+)/i,
    name: "scratch:tool-call-narration",
  },
  { pattern: /\bThis time for sure\b/i, name: "scratch:this-time-for-sure" },
  { pattern: /\btool call incoming\b/i, name: "scratch:tool-call-incoming" },
  { pattern: /\[invoking\]/i, name: "scratch:invoking-bracket" },
  { pattern: /\bOpening the file\b/i, name: "scratch:opening-the-file" },
  { pattern: /\bLet['’]?s try again\b/i, name: "scratch:lets-try-again" },
  // "Go." on its own line — common scratch punctuation, rare in reviews.
  { pattern: /^\s*Go\.\s*$/m, name: "scratch:go-dot" },
  // "Sorry, executing now" / "I'll just proceed" — tool-loop fallback phrases
  // from PR #753 (the calibration data file has the detail).
  { pattern: /\bSorry,\s*executing now\b/i, name: "scratch:sorry-executing-now" },
  { pattern: /\bI['’]?ll just proceed\b/i, name: "scratch:ill-just-proceed" },
  // OpenAI tool-protocol routing tokens that leaked into visible output on the
  // live bot review of PR #758. `to=functions.<tool>` is the OpenAI Assistants
  // tool-dispatch syntax; it is never intentional in a review body.
  { pattern: /\bto=functions\.[a-z_][a-z_0-9]*/i, name: "scratch:openai-tool-routing" },
  // Tool-loop self-narration — the reviewer describing its own tool failures
  // rather than the PR under review. Also from PR #758.
  {
    pattern: /\btool (?:glitch|is glitching|seems to be glitching)\b/i,
    name: "scratch:tool-glitch",
  },
];

// "Narrative" pattern — these phrases appear in legitimate prose occasionally,
// so we only count them as a signal when paired with a long prefix.
//
// Split into three alternatives because "I'll" binds apostrophe directly to
// "I" (no space), while "I will" and "I am going to" take whitespace — a
// single `\s+` branch would have missed "I'll" entirely. Both ASCII `'` and
// curly `’` apostrophes match.
// Exported so calibration tooling can reuse the canonical pattern (mt#1264 R1).
export const NARRATIVE_SCRATCH_PATTERN = /\bI\s+will\b|\bI['’]ll\b|\bI\s+am\s+going\s+to\b/i;

// 20+ consecutive newlines (19 blanks after the first) — no legitimate review
// body contains this. Catches the "hundreds of blank lines" pattern from #743.
// CRLF-safe: accepts either LF or CRLF line endings (GitHub API can return
// either depending on path).
const BLANK_LINE_RUN_RE = /\r?\n(?:[ \t]*\r?\n){19,}/;

// Above this prefix length, a narrative-scratch phrase is treated as a signal.
// Below, we assume it's legitimate "I will focus on..."-style intro prose.
//
// Threshold calibrated 2026-04-26 (mt#1264) via replay against the full
// minsky-reviewer[bot] review corpus — at-risk zone (prefix >= 300 + narrative
// + sole signal) had 0 samples. See docs/architecture/critic-constitution-reliability.md.
// Exported so calibration tooling can compare against the canonical threshold
// rather than hardcoding its own copy (mt#1264 R1).
export const NARRATIVE_TOLERANCE_CHARS = 300;

// User-facing notice that replaces the body when a CoT leak has no
// recoverable structural section. Internal tracker IDs (mt#1212) are
// deliberately omitted — the empty-output sibling notice follows the same
// policy. Point curious operators at the architecture doc instead.
const ERROR_NOTICE_BODY =
  "**reviewer-service error: chain-of-thought leakage detected**\n\n" +
  "The upstream model emitted raw internal reasoning into the review body. " +
  "The reviewer service sanitised the output but could not locate a valid " +
  "`Findings` section to preserve, so the leaked content was discarded. " +
  "The PR will receive a fresh review on the next commit. See " +
  "`docs/architecture/critic-constitution-reliability.md` for details.";

// URL pattern: http:// or https:// followed by non-whitespace chars.
const URL_PATTERN = /https?:\/\/\S+/g;

// Email pattern: standard user@domain.tld form.
// Hyphen is placed at the end of each character class to avoid useless-escape.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Return a redacted snippet of `text` suitable for structured log payloads.
 *
 * Takes the first `maxChars` characters of the text, then replaces:
 *   - URLs (`http://` / `https://`) → `[url]`
 *   - Email addresses → `[email]`
 *
 * Exported so unit tests can verify the redaction in isolation. Used by
 * `review-worker.ts` to attach a redacted prefix snippet to
 * `reviewer.cot_leak_detected` events for calibration (mt#1264).
 */
export function redactForLog(text: string, maxChars = 200): string {
  const snippet = text.slice(0, maxChars);
  return snippet.replace(URL_PATTERN, "[url]").replace(EMAIL_PATTERN, "[email]");
}

export function sanitizeReviewBody(raw: string): SanitizeResult {
  const originalLength = raw.length;

  // Locate the first structural heading, if any. Everything before it is the
  // "prefix" we scan for CoT signals.
  const headingMatch = STRUCTURAL_HEADING_RE.exec(raw);
  const prefix = headingMatch ? raw.slice(0, headingMatch.index) : raw;

  const hasBlankRun = BLANK_LINE_RUN_RE.test(prefix);
  const strongHits = STRONG_SCRATCH_PATTERNS.filter(({ pattern }) => pattern.test(prefix));
  const narrativeHit = NARRATIVE_SCRATCH_PATTERN.test(prefix);
  const narrativePrefixLong = narrativeHit && prefix.length > NARRATIVE_TOLERANCE_CHARS;

  const isCoT = hasBlankRun || strongHits.length > 0 || narrativePrefixLong;

  if (!isCoT) {
    return {
      action: "passthrough",
      body: raw,
      meta: { originalLength, cleanedLength: originalLength },
    };
  }

  const signals: string[] = [];
  if (hasBlankRun) signals.push("blank-line-run");
  for (const { name } of strongHits) signals.push(name);
  if (narrativePrefixLong) signals.push("long-narrative-prefix");

  const reason = `cot-leak:${signals.join(",")}`;

  if (headingMatch) {
    const stripped = raw.slice(headingMatch.index).replace(/^\s+/, "");
    return {
      action: "stripped",
      body: stripped,
      meta: { originalLength, cleanedLength: stripped.length, reason },
    };
  }

  return {
    action: "errored",
    body: ERROR_NOTICE_BODY,
    meta: { originalLength, cleanedLength: ERROR_NOTICE_BODY.length, reason },
  };
}
