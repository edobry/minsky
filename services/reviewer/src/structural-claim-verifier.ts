/**
 * Deterministic falsification of structurally-checkable BLOCKING findings (mt#3245).
 *
 * A narrow, deliberately non-general slice of mt#2960's finder->verifier architecture.
 * mt#2960 is the general confidence-scored verification pipeline (thresholds, per-finding
 * scoring, metrics persistence); this module does NOT build that. It implements exactly one
 * claim class — "identifier X is duplicate-declared in file Y" — with a single deterministic
 * check, following the same pure-function + async-fetcher-wrapper shape as the sibling
 * recovery/verification passes (severity-recovery.ts, refutation-recovery.ts,
 * doc-impact-verifier.ts). If a future mt#2960 pass needs a second claim class, the seam is
 * `applyStructuralClaimVerification`'s per-finding dispatch — add a new claim extractor +
 * checker pair there rather than a new top-level pipeline stage.
 *
 * ## Origin (mt#2575 instance 5, mt#3245 spec)
 *
 * PR #2325 (2026-07-26) added `prompt.test.ts` as a pure-insertion diff (123 insertions, 0
 * deletions). Two identifiers each appeared exactly twice among the added lines — once
 * DECLARED, once USED — in hunks ~1400 lines apart:
 *
 *   DOES_NOT_COVER_H2_HEADING: declared line 51, used line 1440
 *   MT3001_SPEC_EXCERPT:       declared line 1486, used line 1508
 *
 * The reviewer counted identifier OCCURRENCES and reported them as duplicate DECLARATIONS,
 * across two independent review rounds (R1 and R2, one identifier each). Its own finding text
 * described the pattern precisely: R1 called the usage site "a second identical declaration";
 * R2 called it a "re-declar[ation]". `validate_typecheck` on the branch returned zero errors —
 * a duplicate top-level `const` is a compile error, so the claim was directly falsifiable, and
 * false. The reviewer had `read_file` available (Principle 11 instructs aggressive use) and did
 * not consult it before asserting a BLOCKING compile-defect claim (the exact case Principle 13
 * forbids) — evidence that a prompt-only fix does not hold for this class; see the mt#3245 spec's
 * "Why a prompt instruction will not fix this" section.
 *
 * ## Design: reuse the SAME declaration-form definition on both sides of the check
 *
 * "Occurrences are not declarations" is the load-bearing distinction the incident violated. This
 * module counts DECLARATION FORMS only — `const X =`, `let X =`, `var X =`, `function X`,
 * `class X`, `type X =`, `interface X` — never bare identifier appearances (a usage, an import,
 * a property access, a string mention). The same declaration-form regex set is used twice:
 *
 *   1. To extract WHICH identifier a finding's text claims is duplicated (scanning the finding's
 *      own summary/details for an embedded declaration-shaped excerpt, e.g. a quoted
 *      "`const FOO = ...`" snippet the reviewer pasted as evidence).
 *   2. To count how many times that identifier is ACTUALLY declared in the file's current
 *      content (fetched fresh, not derived from the diff — see below).
 *
 * Reusing one definition for both means "what counts as a declaration" cannot drift between
 * interpreting the claim and verifying it.
 *
 * ## Design: current file content, not the diff
 *
 * The incident's two declaration/usage pairs were split across distant hunks, so a diff-only
 * count reproduces the exact failure the incident exhibits (either hunk alone can look like "the
 * only occurrence," or naive concatenation of the diff's added lines re-creates the "2
 * occurrences" miscount). This module requires the file's actual current content at the review
 * ref — the same `readFileAtRef` primitive the model's own `read_file` tool and
 * `doc-impact-verifier.ts` already use — not `pr.diff`.
 *
 * ## Precision-vs-recall guard
 *
 * A finding is only ever touched when exactly ONE distinct identifier can be extracted from its
 * text via the declaration-form scan AND the file's current content is fetchable. Zero or
 * multiple distinct candidates, or a fetch failure, leave the finding untouched (fail-safe
 * preserve BLOCKING) — this module does not guess. A genuinely duplicated identifier (declaration
 * count > 1) also leaves the finding untouched: this pass only ever DEMOTES a false claim, never
 * fabricates evidence for a true one.
 *
 * Pure functions for the extraction/counting/demotion logic (unit-testable without I/O); one
 * async wrapper (`fetchAndApplyStructuralClaimVerification`) performs the file fetch, mirroring
 * `fetchAndVerifyDocImpact`'s shape.
 */

import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

// ---------------------------------------------------------------------------
// Declaration-form definitions (shared between claim-extraction and counting)
// ---------------------------------------------------------------------------

/** Generic identifier character class (no anchors — callers add `\b` as needed). */
const IDENTIFIER_CHARS = "[A-Za-z_$][A-Za-z0-9_$]*";

/**
 * Build the seven declaration-form regex sources for a given identifier pattern (either the
 * generic `IDENTIFIER_CHARS` class, for extraction, or one escaped literal identifier, for
 * counting). The identifier itself is always capture group 1.
 *
 * Tolerates an `export`/`export default`/`async`/`abstract`/`declare` prefix (those precede the
 * keyword, so the leading `\b` still anchors correctly) and a TypeScript type annotation before
 * `=` on `const`/`let`/`var`/`type` (`const X: Foo = ...`).
 */
function declarationFormSources(idPattern: string): string[] {
  return [
    `\\bconst\\s+(${idPattern})\\b\\s*(?::[^=;\\n]+)?=`,
    `\\blet\\s+(${idPattern})\\b\\s*(?::[^=;\\n]+)?=`,
    `\\bvar\\s+(${idPattern})\\b\\s*(?::[^=;\\n]+)?=`,
    `\\bfunction\\s*\\*?\\s+(${idPattern})\\b`,
    `\\bclass\\s+(${idPattern})\\b`,
    `\\btype\\s+(${idPattern})\\b[^=;\\n]*=`,
    `\\binterface\\s+(${idPattern})\\b`,
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip `//` line comments, `/* *\/` block comments, and string/template literal bodies from
 * `content`, replacing stripped characters with spaces (newlines are preserved as newlines, so
 * line count is unchanged — not load-bearing here since counting doesn't use line numbers, but
 * keeps the output easy to reason about).
 *
 * Minimal single-pass tokenizer (reviewer PR #2334 R1 finding, verified real): without this,
 * `countDeclarationForms` runs over raw file text, so a doc-comment or a template-literal value
 * that QUOTES a declaration-shaped excerpt (e.g. a JSDoc example, or exactly the kind of
 * `` `const X = ...` `` string this module's own test fixtures and doc comments contain) inflates
 * the count — confirmed empirically: a file with one real `const FOO = 1;` plus a comment
 * containing the literal text `const FOO = 1;` counted as 2, not 1. Inflation is dangerous in the
 * PRESERVE direction: `declarationCount > 1` preserves BLOCKING, so a comment artifact could keep
 * a genuinely-false claim posted as BLOCKING — the opposite of what this module exists to fix.
 *
 * Deliberately simple, not a full lexer: template-literal `${...}` interpolation is NOT
 * specially tracked — the whole `` `...` `` span (including any `${}` inside it) is treated as
 * string content. This can only under-count (miss a genuine declaration written inside a
 * template-literal interpolation, an extremely rare pattern), never over-count, so it does not
 * reintroduce the false-BLOCKING-preservation risk this pre-pass exists to close. Regex literals
 * (`/pattern/flags`) are not tracked either (real risk, judged low: a regex containing the exact
 * text `const X =` immediately followed by a real duplicate elsewhere is not a shape observed in
 * this codebase's reviewer-flagged files) — noted here rather than silently ignored.
 */
function stripCommentsAndStrings(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === "/" && next === "/") {
      // Line comment: blank out through end of line (newline itself preserved).
      while (i < n && content[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) {
        out += content[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += " ";
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += content[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Count declaration FORMS (not occurrences) of `identifier` in `content`. Matches
 * `const X =` / `let X =` / `var X =` / `function X` / `class X` / `type X =` / `interface X`
 * only — a bare usage, import, or property-access mention of `identifier` never matches. Runs
 * against a comments-and-strings-stripped view of `content` (see `stripCommentsAndStrings`) so a
 * comment or string/template literal that merely QUOTES a declaration-shaped excerpt is never
 * counted as a real declaration.
 *
 * Exported for unit testing.
 */
export function countDeclarationForms(content: string, identifier: string): number {
  const escaped = escapeRegExp(identifier);
  const stripped = stripCommentsAndStrings(content);
  let count = 0;
  for (const source of declarationFormSources(escaped)) {
    const matches = stripped.match(new RegExp(source, "g"));
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Extract every identifier that appears in a declaration-FORM shape somewhere in `text` (e.g. a
 * finding's own quoted "`const FOO = ...`" evidence excerpt). Returns the distinct set found, in
 * first-seen order. A bare backtick-quoted identifier with no declaration form around it (a
 * lexical anchor like "after `const OTHER_CONST`)" with no trailing `=`) is NOT extracted — this
 * is deliberate: it is what let a real finding's anchor reference to unrelated surrounding code
 * be mistaken for the claimed identifier in earlier drafts of this check.
 *
 * Exported for unit testing.
 */
export function extractDeclaredIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const source of declarationFormSources(IDENTIFIER_CHARS)) {
    for (const match of text.matchAll(new RegExp(source, "g"))) {
      const id = match[1];
      if (id) found.add(id);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Claim detection
// ---------------------------------------------------------------------------

/**
 * Trigger phrases for a duplicate-identifier / duplicate-declaration claim. `\p{Pd}` (Unicode
 * "Dash Punctuation") matches any hyphen-like character — ASCII hyphen, en/em dash, or the
 * non-breaking hyphen (U+2011) GPT-5 output has been observed to emit (e.g. "duplicate‑identifier")
 * — so the trigger fires regardless of which dash variant the model used.
 */
const DUPLICATE_DECLARATION_TRIGGER_RE =
  /duplicate[\s\p{Pd}]*(identifier|declaration|const|let|var|function|class|type|interface)|declared\s+(twice|more than once)|already\s+declared|re[\s\p{Pd}]*declar|second\s+(identical\s+)?(occurrence|declaration)/imu;

/**
 * If `summary`+`details` (a `submit_finding` call's text) makes a duplicate-identifier /
 * duplicate-declaration claim AND exactly one identifier can be confidently extracted from its
 * own declaration-shaped evidence text, return that identifier. Otherwise (no trigger phrase, no
 * extractable identifier, or more than one distinct candidate — ambiguous) return `null`: this
 * function only ever returns a HIGH-CONFIDENCE single candidate, never a guess.
 *
 * Exported for unit testing.
 */
export function extractDuplicateDeclarationClaim(summary: string, details: string): string | null {
  const text = `${summary}\n${details}`;
  if (!DUPLICATE_DECLARATION_TRIGGER_RE.test(text)) return null;

  const candidates = extractDeclaredIdentifiers(text);
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Audit-log entry produced for each finding this pass demotes. */
export interface StructuralClaimDowngradeAuditEntry {
  file: string;
  /** The single claim class this module implements (mt#2960 plugs in more later). */
  claimClass: "duplicate-declaration";
  identifier: string;
  /** Actual declaration-form count found in the file's current content (always <= 1 here). */
  declarationCount: number;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  reason: string;
}

export interface StructuralClaimVerificationResult {
  /** Same length/order as input; only demoted `submit_finding` severities differ. */
  toolCalls: ReviewToolCall[];
  downgrades: StructuralClaimDowngradeAuditEntry[];
}

// ---------------------------------------------------------------------------
// Pure verification pass
// ---------------------------------------------------------------------------

/**
 * Apply duplicate-declaration verification to a list of model tool calls.
 *
 * `fileContents` maps the file path a finding cites to its CURRENT content at the review ref
 * (`undefined` or `null` means "could not fetch" — the finding is left untouched, fail-safe).
 *
 * Pure function — no I/O. Callers needing to fetch content should use
 * `fetchAndApplyStructuralClaimVerification` below.
 */
export function applyStructuralClaimVerification(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  fileContents: ReadonlyMap<string, string | null>
): StructuralClaimVerificationResult {
  const corrected: ReviewToolCall[] = [];
  const downgrades: StructuralClaimDowngradeAuditEntry[] = [];

  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      corrected.push(tc);
      continue;
    }

    const identifier = extractDuplicateDeclarationClaim(tc.args.summary, tc.args.details);
    if (!identifier) {
      corrected.push(tc);
      continue;
    }

    const content = fileContents.get(tc.args.file);
    if (content === undefined || content === null) {
      // Could not fetch the file's current content — cannot verify. Fail safe: preserve
      // BLOCKING rather than assert either way (mirrors Principle 13's "could not verify is a
      // question, never grounds to act on" — applied here to preserving rather than asserting).
      corrected.push(tc);
      continue;
    }

    const declarationCount = countDeclarationForms(content, identifier);
    if (declarationCount > 1) {
      // Genuinely duplicated — the recall-side guard: a seeded finding naming a truly
      // duplicated identifier must still post as BLOCKING. Preserve unchanged.
      corrected.push(tc);
      continue;
    }

    const reason =
      `structural-claim-verification: finding claims "${identifier}" is duplicate-declared in ` +
      `"${tc.args.file}", but a declaration-form count (const/let/var/function/class/type/` +
      `interface) against the file's current content at the review ref found ` +
      `${declarationCount} declaration(s) — occurrences elsewhere in the file (e.g. a usage ` +
      `site) are not declarations. Downgraded.`;

    const downgradedArgs: SubmitFindingArgs = {
      ...tc.args,
      severity: "NON-BLOCKING",
      summary: `${tc.args.summary} [duplicate-declaration-unverified]`,
      details: `${tc.args.details}\n\n_${reason}_`,
    };
    corrected.push({ name: "submit_finding", args: downgradedArgs });
    downgrades.push({
      file: tc.args.file,
      claimClass: "duplicate-declaration",
      identifier,
      declarationCount,
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      reason,
    });
  }

  return { toolCalls: corrected, downgrades };
}

// ---------------------------------------------------------------------------
// Async fetch-and-apply wrapper
// ---------------------------------------------------------------------------

export type FileContentFetcher = (path: string) => Promise<string | null>;

/**
 * Fetch current file content (only for files a duplicate-declaration claim actually needs — no
 * fetch at all when no BLOCKING finding matches the claim shape) and apply
 * `applyStructuralClaimVerification`.
 *
 * Mirrors `fetchAndVerifyDocImpact`'s shape (doc-impact-verifier.ts): caller supplies a
 * `FileContentFetcher` (production wiring uses `readFileAtRef` against the PR head ref; tests
 * supply an in-memory stub).
 */
export async function fetchAndApplyStructuralClaimVerification(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  fileFetcher: FileContentFetcher
): Promise<StructuralClaimVerificationResult> {
  const filesToFetch = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") continue;
    if (extractDuplicateDeclarationClaim(tc.args.summary, tc.args.details)) {
      filesToFetch.add(tc.args.file);
    }
  }

  if (filesToFetch.size === 0) {
    return { toolCalls: [...toolCalls], downgrades: [] };
  }

  const fileContents = new Map<string, string | null>();
  for (const path of filesToFetch) {
    try {
      fileContents.set(path, await fileFetcher(path));
    } catch {
      fileContents.set(path, null);
    }
  }

  return applyStructuralClaimVerification(toolCalls, fileContents);
}
