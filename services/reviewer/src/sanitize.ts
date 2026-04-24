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
// model to emit. `#`/`##`/`###`/`####` or a bold **Heading** both match.
// Note: we intentionally use `[ \t]*` (not `\s*`) so the regex doesn't
// greedily consume newlines before the heading — that would truncate the
// prefix we scan for CoT signals and make blank-line-run detection miss.
const STRUCTURAL_HEADING_RE =
  /^[ \t]*(?:#{1,4}[ \t]+|\*\*)(findings|spec verification|summary|documentation impact)\b/im;

// "Strong" scratch patterns — each one alone is enough to fire the heuristic.
// These are phrases a well-formed review body never contains at the top.
const STRONG_SCRATCH_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // "Calling read_file on src/foo.ts." / "Calling list_directory."
  {
    pattern: /\bCalling\s+[a-z_][a-z_0-9]*(?:\s+on\s+\S+)?[.,]/i,
    name: "scratch:tool-call-narration",
  },
  { pattern: /\bThis time for sure\b/i, name: "scratch:this-time-for-sure" },
  { pattern: /\btool call incoming\b/i, name: "scratch:tool-call-incoming" },
  { pattern: /\[invoking\]/i, name: "scratch:invoking-bracket" },
  { pattern: /\bOpening the file\b/i, name: "scratch:opening-the-file" },
  { pattern: /\bLet'?s try again\b/i, name: "scratch:lets-try-again" },
  // "Go." on its own line — common scratch punctuation, rare in reviews.
  { pattern: /^\s*Go\.\s*$/m, name: "scratch:go-dot" },
  // "Sorry, executing now" / "I'll just proceed" — tool-loop fallback phrases
  // from PR #753 (the calibration data file has the detail).
  { pattern: /\bSorry,\s*executing now\b/i, name: "scratch:sorry-executing-now" },
  { pattern: /\bI['']?ll just proceed\b/i, name: "scratch:ill-just-proceed" },
];

// "Narrative" pattern — these phrases appear in legitimate prose occasionally,
// so we only count them as a signal when paired with a long prefix.
const NARRATIVE_SCRATCH_PATTERN = /\bI\s+(?:will|['']ll|am\s+going\s+to)\b/i;

// 20+ consecutive newlines (19 blanks after the first) — no legitimate review
// body contains this. Catches the "hundreds of blank lines" pattern from #743.
const BLANK_LINE_RUN_RE = /\n(?:[ \t]*\n){19,}/;

// Above this prefix length, a narrative-scratch phrase is treated as a signal.
// Below, we assume it's legitimate "I will focus on..."-style intro prose.
const NARRATIVE_TOLERANCE_CHARS = 300;

const ERROR_NOTICE_BODY =
  "**reviewer-service error: chain-of-thought leakage detected**\n\n" +
  "The upstream model emitted raw internal reasoning into the review body. " +
  "The reviewer service sanitised the output but could not locate a valid " +
  "`Findings` section to preserve, so the leaked content was discarded. " +
  "This is tracked as a reliability event (mt#1212). The PR will receive a " +
  "fresh review on the next commit.";

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
