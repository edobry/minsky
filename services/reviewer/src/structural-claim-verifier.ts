/**
 * Deterministic falsification of structurally-checkable BLOCKING findings (mt#3245).
 *
 * A narrow, deliberately non-general slice of mt#2960's finder->verifier architecture.
 * mt#2960 is the general confidence-scored verification pipeline (thresholds, per-finding
 * scoring, metrics persistence); this module does NOT build that. It implements a small, fixed
 * set of claim classes, each with a single deterministic check, following the same pure-function
 * + async-fetcher-wrapper shape as the sibling recovery/verification passes (severity-recovery.ts,
 * refutation-recovery.ts, doc-impact-verifier.ts):
 *
 *   1. "identifier X is duplicate-declared in file Y"  (mt#3245, origin below)
 *   2. "section/heading H appears more than once in file Y"  (mt#3520, origin below)
 *   3. "file/entry F is missing / not present"  (mt#4042, origin below)
 *
 * Class 3 runs the check in the OPPOSITE direction from classes 1 and 2, which is the only real
 * asymmetry in this module. A duplication claim is disproven by a count of `<= 1`; an ABSENCE
 * claim is disproven by PRESENCE, so class 3 demotes on `>= 1`. Everything else — extract the
 * subject from the finding's own evidence, check it against the repo at the review ref, demote
 * only on disproof — is the same skeleton.
 *
 * A future class plugs in at `extractStructuralClaim`'s dispatch — add a claim extractor +
 * counter pair there rather than a new top-level pipeline stage. Both classes share the same
 * skeleton: extract the claim's subject(s) from the finding's own evidence, count each subject in
 * the file's CURRENT content at the review ref, and demote only when the counts disprove the
 * claim.
 *
 * The classes differ in extraction CARDINALITY, deliberately. The declaration class takes exactly
 * ONE identifier — more than one candidate means genuine ambiguity about which the claim is about
 * (its extraction can pick up an unrelated anchor identifier), so it declines. The section class
 * takes the whole quoted SET (capped at `MAX_SECTION_CANDIDATES`), because naming a neighbouring
 * landmark heading alongside the claimed one is ordinary prose — the real originating finding does
 * exactly that. Demotion then requires ALL of the set to be non-duplicated, so the wider
 * extraction is strictly more conservative, never less. See `extractDuplicateSectionClaim`.
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
 * ## Origin of class 2 (mt#2575 instance 6, mt#3520 spec)
 *
 * PR #2498 (2026-08-01) added a gate criterion to `.minsky/skills/plan-task/skill.ts` and, as every
 * skill change must, to its compile output `.claude/skills/plan-task/SKILL.md` (ADR-015:
 * `.claude/skills/<name>/SKILL.md` is ALWAYS a compile output, never the canonical source). The
 * reviewer posted a BLOCKING finding that the new `#### Gate criterion (p) ...` section "appears
 * twice" in the SOURCE file and that `### Step 4: Act on gate results` was repeated. Both appear
 * exactly once per file; the manifest test the finding predicted would fail passed 3/3. It
 * restated the claim on a retrigger of the same HEAD even after the PR body carried the per-file
 * counts, and its own spec-verification table simultaneously recorded "a single (p) section" as
 * Met — so in-context prose does not correct this class either.
 *
 * ## Origin of class 3 (mt#2575 instance 7, mt#4042 spec)
 *
 * PR #2909 (2026-08-12) added a detector plus its index entry in `.minsky/rules/hook-observers.mdc`
 * — an in-diff change at line 55 of that file. The reviewer posted BLOCKING: "Index entry missing
 * in `hook-observers.mdc` as required by the spec," citing as evidence that
 * `docs/architecture/hook-observers.mdc` returned `not_found` and that the
 * `docs/architecture/hooks/` listing did not contain it either.
 *
 * Both evidence lines are TRUE. Neither is where the file lives. The finding took a bare filename
 * from the prose of `docs/architecture/hooks/flakiness-control-detector.md` and looked for it in
 * that document's own directory and its parent — but a bare `hook-observers.mdc` in this corpus is
 * how a rule is NAMED, not where it sits, and no rule sits under `docs/`.
 *
 * That is what separates this class from the two above, and from instance 1 of the same family
 * (PR #1766, a broken-cross-reference claim diagnosed at the time as "the reviewer cannot see the
 * filesystem"). Here the reviewer HAD `read_file`, USED it, and got a truthful miss for a path
 * that was never the right path — then reported the miss as absence. The finding arrives WITH
 * evidence attached, and the evidence is real, which is precisely why a reader believes it.
 *
 * A second, independently-documented mechanism produces the identical claim shape with no
 * source/generated pair involved: mem#648 (PR #2106, 2026-07-20/21) records a false "Duplicate
 * '# Claim Confidence' section appears twice in AGENTS.md" on a LONG single section whose start
 * and end were read as two sections, with inconsistent phantom line numbers across rounds. This
 * check is therefore deliberately mechanism-INDEPENDENT: it counts the heading in the file and
 * does not care why the model believed otherwise.
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
// Section-heading definitions (shared between claim-extraction and counting)
// ---------------------------------------------------------------------------

/**
 * ATX markdown heading form: 1-6 `#` followed by whitespace and non-empty text. Used on BOTH
 * sides of the duplicate-section check — to recognize a heading inside a finding's own quoted
 * evidence, and to recognize a heading line in the file's content — so "what counts as a heading"
 * cannot drift between interpreting the claim and verifying it (the same discipline the
 * declaration-form set above applies to its own class).
 */
const HEADING_FORM_RE = /^#{1,6}[ \t]+\S.*$/;

/** Quoted spans a model uses to embed a heading in prose: `backtick`, 'single', "double". */
const QUOTED_SPAN_RE = /`([^`\n]+)`|'([^'\n]+)'|"([^"\n]+)"/g;

/**
 * Normalize a heading for comparison: collapse internal whitespace runs to one space, trim, and
 * fold every Unicode dash (`\p{Pd}` — ASCII hyphen, en/em dash, the non-breaking hyphen U+2011
 * GPT-5 has been observed to emit) to a plain hyphen.
 *
 * Applied to BOTH the claimed heading and each candidate line in the file, so the comparison is
 * symmetric. Dash folding is recall-only: without it, a model that re-typed an em dash as a
 * hyphen would simply fail to match and the finding would be left untouched (fail-safe), never
 * wrongly demoted.
 */
function normalizeHeading(raw: string): string {
  return raw
    .replace(/\p{Pd}/gu, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Count lines in `content` whose normalized form equals the normalized `heading`.
 *
 * Deliberately runs against RAW content — NOT the `stripCommentsAndStrings` view the
 * declaration-form counter uses. That difference is load-bearing, not an oversight: a canonical
 * skill/rule source in this repo carries its entire markdown body inside a TypeScript template
 * literal (`.minsky/skills/<name>/skill.ts`'s `content:` field), so stripping string bodies would
 * blank out every real heading and return 0 for a file that genuinely contains the heading twice
 * — silently demoting a TRUE finding. The stripper exists for the declaration class because a
 * comment QUOTING `const X =` is not a declaration; a heading inside a skill source's template
 * literal, by contrast, IS the real heading.
 *
 * Exported for unit testing.
 */
export function countHeadingOccurrences(content: string, heading: string): number {
  const target = normalizeHeading(heading);
  if (target === "") return 0;
  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!HEADING_FORM_RE.test(trimmed)) continue;
    if (normalizeHeading(trimmed) === target) count++;
  }
  return count;
}

/**
 * Extract every heading that appears inside a quoted span in `text` (e.g. a finding's own
 * "The heading `#### Foo` appears twice" evidence). Returns the distinct set in first-seen order,
 * normalized. Only quoted spans are considered — an unquoted `#` in prose is far more often a PR
 * or issue reference than a heading.
 *
 * Exported for unit testing.
 */
export function extractQuotedHeadings(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    const span = match[1] ?? match[2] ?? match[3];
    if (!span) continue;
    const trimmed = span.trim();
    if (!HEADING_FORM_RE.test(trimmed)) continue;
    found.add(normalizeHeading(trimmed));
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

/**
 * Trigger phrases for a duplicate-SECTION / duplicate-heading claim — the second claim class
 * (mt#3520). Kept separate from the declaration trigger above because the two classes have
 * disjoint evidence shapes (an identifier in a declaration form vs. a heading in a quoted span),
 * and because dispatch tries declaration first.
 *
 * `appears twice` is deliberately included even though it is generic on its own: it only ever
 * reaches a demotion when the same finding ALSO yields at least one quoted heading AND every one
 * of those headings is non-duplicated in the file. That conjunction, not the trigger phrase, is
 * the real precision guard.
 */
const DUPLICATE_SECTION_TRIGGER_RE =
  /duplicate[\s\p{Pd}]*(section|heading|block)|(section|heading|block)[^.\n]{0,60}duplicat|repeated\s+(section|heading|block)|appears\s+twice|appears\s+(more\s+than\s+once|again\s+later)|(section|heading|block)[^.\n]{0,60}(twice|more than once)/imu;

/**
 * Upper bound on quoted headings considered for one finding. A finding naming more headings than
 * this is prose about document structure generally, not a specific duplication claim — leave it
 * alone rather than fan out fetches and counts.
 */
const MAX_SECTION_CANDIDATES = 4;

/**
 * If `summary`+`details` makes a duplicate-section / duplicate-heading claim, return EVERY
 * heading quoted in its evidence (normalized, distinct, first-seen order). Returns `null` when
 * there is no trigger phrase, no quoted heading, or implausibly many.
 *
 * ## Why this returns a SET, unlike the declaration class's single candidate
 *
 * The declaration class demands exactly one candidate because its extraction can pick up an
 * unrelated ANCHOR identifier ("...after `const OTHER_CONST`"), leaving genuine ambiguity about
 * which identifier the claim is about. Section findings have the opposite shape: naming a
 * neighbouring landmark heading alongside the claimed one is ordinary prose. The real
 * originating finding (PR #2498) reads "the heading `#### Gate criterion (p) ...` appears twice
 * ... and again later before the `### Step 4: Act on gate results` section repeats" — TWO quoted
 * headings, one claim. An exactly-one rule would have silently skipped the very finding this
 * class exists to catch.
 *
 * Verifying ALL of them is strictly MORE conservative than picking one, because the caller
 * demotes only when EVERY quoted heading is non-duplicated: a single genuinely-duplicated
 * heading anywhere in the set preserves BLOCKING. So the widened extraction cannot demote a
 * true finding that the narrow rule would have preserved.
 *
 * Exported for unit testing.
 */
export function extractDuplicateSectionClaim(summary: string, details: string): string[] | null {
  const text = `${summary}\n${details}`;
  if (!DUPLICATE_SECTION_TRIGGER_RE.test(text)) return null;

  const candidates = extractQuotedHeadings(text);
  if (candidates.length === 0 || candidates.length > MAX_SECTION_CANDIDATES) return null;
  return candidates;
}

// ---------------------------------------------------------------------------
// Missing-subject definitions (class 3)
// ---------------------------------------------------------------------------

/**
 * Trigger phrases for an ABSENCE claim. Deliberately broad on its own: like the section class's
 * `appears twice`, the precision guard is not the phrase but the conjunction — a demotion also
 * requires a file-shaped subject quoted in the finding's own evidence AND that subject actually
 * resolving in the repo at the review ref.
 */
const MISSING_SUBJECT_TRIGGER_RE =
  /\b(?:missing|absent)\b|\bnot\s+(?:present|found|added|documented|included)\b|\bdoes\s*n[o'’]?t\s+exist\b|\bno\s+such\s+(?:file|entry|section|path)\b|\bnever\s+(?:added|created|documented)\b|\bnot_found\b/imu;

/**
 * A quoted span that looks like a file reference: no whitespace, and a short trailing extension.
 * Requiring the extension is what keeps ordinary backticked prose (`checks:write`, `read_file`,
 * an identifier) out of the subject set.
 */
const FILE_REF_RE = /^[A-Za-z0-9._\-/@]+\.[A-Za-z0-9]{1,8}$/;

/** Upper bound on subjects considered for one finding — see `MAX_SECTION_CANDIDATES`. */
const MAX_MISSING_SUBJECTS = 6;

/**
 * If `summary`+`details` claims something is missing AND quotes at least one file-shaped
 * reference, return those references (distinct, first-seen order). Otherwise `null`.
 *
 * Exported for unit testing.
 */
export function extractMissingSubjectClaim(summary: string, details: string): string[] | null {
  const text = `${summary}\n${details}`;
  if (!MISSING_SUBJECT_TRIGGER_RE.test(text)) return null;

  const found = new Set<string>();
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    const span = (match[1] ?? match[2] ?? match[3])?.trim();
    if (!span) continue;
    if (!FILE_REF_RE.test(span)) continue;
    found.add(span);
  }

  const candidates = [...found];
  if (candidates.length === 0 || candidates.length > MAX_MISSING_SUBJECTS) return null;
  return candidates;
}

/**
 * Match a quoted file reference against a repo path listing.
 *
 * An EXPLICIT path (contains `/`) is checked as written: naming a full path is a stronger, more
 * specific claim than naming a file, and a reviewer that says `docs/foo/bar.md` does not exist is
 * making a claim about that path. A BARE filename matches on basename anywhere in the tree —
 * which is the entire point of the class, since a bare name in prose is a NAME, not a location.
 *
 * Lives here rather than in the caller so the rule is unit-testable independently of GitHub;
 * `review-worker.ts` supplies the listing and calls this.
 *
 * Exported for unit testing.
 */
export function matchPathsForFileRef(fileRef: string, paths: readonly string[]): string[] {
  if (fileRef.includes("/")) {
    return paths.filter((p) => p === fileRef);
  }
  return paths.filter((p) => p === fileRef || p.endsWith(`/${fileRef}`));
}

/**
 * Whether an absence claim naming `subjects` is disproven by `resolvedPaths`.
 *
 * ## Why ANY, when the section class requires ALL
 *
 * The section class demotes only when EVERY quoted heading is non-duplicated, because there each
 * additional subject is another chance for the claim to be TRUE. Here the polarity is reversed and
 * so is the quantifier: the claim is that something is missing, and locating it ONCE disproves the
 * claim entirely.
 *
 * This is not a loosening — it is what makes the check work on its own originating incident, and
 * getting it backwards would have produced a check that cannot fire there. PR #2909's finding
 * quotes TWO subjects: the bare `hook-observers.mdc` (which resolves) and the constructed
 * `docs/architecture/hook-observers.mdc` (which does not, because it was never a real path). Under
 * an ALL rule the constructed path preserves BLOCKING and the false finding survives. A path the
 * reviewer built wrongly failing to resolve is the ERROR being corrected, not a second piece of
 * evidence for absence.
 *
 * Exported for unit testing.
 */
export function isAbsenceClaimDisproven(
  subjects: readonly string[],
  resolvedPaths: ReadonlyMap<string, readonly string[]>
): boolean {
  return subjects.some((subject) => (resolvedPaths.get(subject)?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Fields common to every claim class's audit entry. */
interface StructuralClaimDowngradeAuditBase {
  file: string;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  reason: string;
}

/** Audit entry for the duplicate-declaration class (mt#3245). */
export interface DuplicateDeclarationDowngradeAuditEntry extends StructuralClaimDowngradeAuditBase {
  claimClass: "duplicate-declaration";
  identifier: string;
  /** Actual declaration-form count found in the file's current content (always <= 1 here). */
  declarationCount: number;
}

/** Audit entry for the duplicate-section class (mt#3520). */
export interface DuplicateSectionDowngradeAuditEntry extends StructuralClaimDowngradeAuditBase {
  claimClass: "duplicate-section";
  /**
   * Every heading quoted by the finding, with its actual count in the file's current content.
   * All counts are <= 1 here — a single count > 1 preserves BLOCKING and produces no entry.
   */
  headings: Array<{ heading: string; occurrenceCount: number }>;
}

/**
 * Audit-log entry produced for each finding this pass demotes. Discriminated on `claimClass`
 * (mt#2960 plugs in more classes later). The only consumer today is `review-worker.ts`, which
 * logs the array wholesale under `reviewer.structural_claim_verification`.
 */
export type StructuralClaimDowngradeAuditEntry =
  | DuplicateDeclarationDowngradeAuditEntry
  | DuplicateSectionDowngradeAuditEntry
  | MissingSubjectDowngradeAuditEntry;

/** Audit entry for the missing-subject class (mt#4042). */
export interface MissingSubjectDowngradeAuditEntry extends StructuralClaimDowngradeAuditBase {
  claimClass: "missing-subject";
  /**
   * Every file-shaped reference the finding quoted, with the repo paths it resolved to at the
   * review ref. At least one entry has a non-empty `resolvedPaths` — that is what demoted the
   * finding. Entries that resolved to nothing are kept deliberately: a constructed path that
   * resolves to nothing beside a bare name that resolves is the signature of this whole class,
   * and a reader of the audit log should be able to see it.
   */
  subjects: Array<{ subject: string; resolvedPaths: string[] }>;
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
 * A recognized structural claim: which class fired, and the subject(s) it named. The declaration
 * class always yields exactly one subject; the section class may yield several (see
 * `extractDuplicateSectionClaim`), and ALL of them must be disproven to demote.
 */
interface ExtractedStructuralClaim {
  claimClass: "duplicate-declaration" | "duplicate-section" | "missing-subject";
  /**
   * The identifier (declaration class), normalized heading(s) (section class), or quoted file
   * reference(s) (missing-subject class).
   */
  subjects: string[];
}

/**
 * Per-finding claim dispatch — the seam this module's header designates for new claim classes.
 * Declaration is tried FIRST: its evidence shape (an identifier inside a declaration form) is the
 * narrower of the two, so a finding that yields a declaration candidate is a declaration claim
 * even if its prose also happens to say "appears twice".
 *
 * Exported for unit testing.
 */
export function extractStructuralClaim(
  summary: string,
  details: string
): ExtractedStructuralClaim | null {
  const identifier = extractDuplicateDeclarationClaim(summary, details);
  if (identifier) return { claimClass: "duplicate-declaration", subjects: [identifier] };

  const headings = extractDuplicateSectionClaim(summary, details);
  if (headings) return { claimClass: "duplicate-section", subjects: headings };

  // Absence is tried LAST: its trigger set is the broadest of the three, so a finding that also
  // yields a duplication candidate is a duplication claim.
  const missing = extractMissingSubjectClaim(summary, details);
  if (missing) return { claimClass: "missing-subject", subjects: missing };

  return null;
}

/**
 * Apply structural-claim verification to a list of model tool calls.
 *
 * `fileContents` maps the file path a finding cites to its CURRENT content at the review ref
 * (`undefined` or `null` means "could not fetch" — the finding is left untouched, fail-safe).
 *
 * Pure function — no I/O. Callers needing to fetch content should use
 * `fetchAndApplyStructuralClaimVerification` below.
 */
export function applyStructuralClaimVerification(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  fileContents: ReadonlyMap<string, string | null>,
  /**
   * Repo paths each quoted file reference resolved to at the review ref (missing-subject class
   * only). A subject absent from this map was never checked — indistinguishable here from one
   * that resolved to nothing, and both preserve BLOCKING, so the conflation is safe in the only
   * direction that matters. Defaults to empty, which disables the class: existing callers that
   * pass two arguments keep their exact behavior.
   */
  resolvedPaths: ReadonlyMap<string, readonly string[]> = new Map()
): StructuralClaimVerificationResult {
  const corrected: ReviewToolCall[] = [];
  const downgrades: StructuralClaimDowngradeAuditEntry[] = [];

  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      corrected.push(tc);
      continue;
    }

    const claim = extractStructuralClaim(tc.args.summary, tc.args.details);
    if (!claim) {
      corrected.push(tc);
      continue;
    }

    if (claim.claimClass === "missing-subject") {
      if (!isAbsenceClaimDisproven(claim.subjects, resolvedPaths)) {
        // Either the subjects genuinely resolve to nothing (the claim may be TRUE — preserve it,
        // this pass never invents an absence) or the resolver could not run. Fail safe.
        corrected.push(tc);
        continue;
      }

      const subjects = claim.subjects.map((subject) => ({
        subject,
        resolvedPaths: [...(resolvedPaths.get(subject) ?? [])],
      }));
      const located = subjects
        .filter((s) => s.resolvedPaths.length > 0)
        .map((s) => `"${s.subject}" -> ${s.resolvedPaths.join(", ")}`)
        .join("; ");
      const reason =
        `structural-claim-verification: finding claims something is missing or not present, but ` +
        `at least one file it names DOES exist in the repo at the review ref — ${located}. A read ` +
        `that returned not_found for a differently-constructed path is a failed lookup, not ` +
        `evidence of absence. Downgraded.`;

      corrected.push({
        name: "submit_finding",
        args: {
          ...tc.args,
          severity: "NON-BLOCKING",
          summary: `${tc.args.summary} [missing-subject-unverified]`,
          details: `${tc.args.details}\n\n_${reason}_`,
        } satisfies SubmitFindingArgs,
      });
      downgrades.push({
        file: tc.args.file,
        claimClass: "missing-subject",
        subjects,
        fromSeverity: "BLOCKING",
        toSeverity: "NON-BLOCKING",
        reason,
      });
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

    const counted = claim.subjects.map((subject) => ({
      subject,
      count:
        claim.claimClass === "duplicate-declaration"
          ? countDeclarationForms(content, subject)
          : countHeadingOccurrences(content, subject),
    }));

    if (counted.some((c) => c.count > 1)) {
      // Genuinely duplicated — the recall-side guard: a seeded finding naming a truly
      // duplicated identifier or heading must still post as BLOCKING. For a multi-heading
      // section claim, ONE duplicated heading is enough to preserve the whole finding.
      corrected.push(tc);
      continue;
    }

    const firstCount = counted[0]?.count ?? 0;
    const reason =
      claim.claimClass === "duplicate-declaration"
        ? `structural-claim-verification: finding claims "${counted[0]?.subject}" is ` +
          `duplicate-declared in "${tc.args.file}", but a declaration-form count (const/let/var/` +
          `function/class/type/interface) against the file's current content at the review ref ` +
          `found ${firstCount} declaration(s) — occurrences elsewhere in the file (e.g. a usage ` +
          `site) are not declarations. Downgraded.`
        : `structural-claim-verification: finding claims a duplicated section in "${tc.args.file}", ` +
          `but counting each quoted heading against the file's current content at the review ref ` +
          `found ${counted.map((c) => `"${c.subject}" x${c.count}`).join(", ")}. A heading ` +
          `repeated across a canonical source and its generated copy, or one long section whose ` +
          `start and end are read as two, is not a duplicate within this file. Downgraded.`;

    const downgradedArgs: SubmitFindingArgs = {
      ...tc.args,
      severity: "NON-BLOCKING",
      summary: `${tc.args.summary} [${claim.claimClass}-unverified]`,
      details: `${tc.args.details}\n\n_${reason}_`,
    };
    corrected.push({ name: "submit_finding", args: downgradedArgs });
    downgrades.push(
      claim.claimClass === "duplicate-declaration"
        ? {
            file: tc.args.file,
            claimClass: "duplicate-declaration",
            identifier: counted[0]?.subject ?? "",
            declarationCount: firstCount,
            fromSeverity: "BLOCKING",
            toSeverity: "NON-BLOCKING",
            reason,
          }
        : {
            file: tc.args.file,
            claimClass: "duplicate-section",
            headings: counted.map((c) => ({ heading: c.subject, occurrenceCount: c.count })),
            fromSeverity: "BLOCKING",
            toSeverity: "NON-BLOCKING",
            reason,
          }
    );
  }

  return { toolCalls: corrected, downgrades };
}

// ---------------------------------------------------------------------------
// Async fetch-and-apply wrapper
// ---------------------------------------------------------------------------

export type FileContentFetcher = (path: string) => Promise<string | null>;

/**
 * Resolve a file reference quoted by a finding to the repo paths matching it at the review ref.
 * A reference containing `/` is taken at face value (an explicit path is a stronger claim than a
 * bare name, so it is checked as written); a bare filename matches on BASENAME anywhere in the
 * tree, which is the whole point — the class exists because a bare name is not a path.
 */
export type PathResolver = (fileRef: string) => Promise<readonly string[]>;

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
  fileFetcher: FileContentFetcher,
  /**
   * Resolves a quoted file reference to the repo paths matching it at the review ref (mt#4042).
   * Optional: omitted, the missing-subject class never fires and the other two are unaffected —
   * the same opt-in shape `resolvedPaths` has on the pure function.
   */
  pathResolver?: PathResolver
): Promise<StructuralClaimVerificationResult> {
  const filesToFetch = new Set<string>();
  const subjectsToResolve = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") continue;
    const claim = extractStructuralClaim(tc.args.summary, tc.args.details);
    if (!claim) continue;
    if (claim.claimClass === "missing-subject") {
      for (const subject of claim.subjects) subjectsToResolve.add(subject);
    } else {
      filesToFetch.add(tc.args.file);
    }
  }

  if (filesToFetch.size === 0 && subjectsToResolve.size === 0) {
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

  const resolvedPaths = new Map<string, readonly string[]>();
  if (pathResolver) {
    for (const subject of subjectsToResolve) {
      try {
        resolvedPaths.set(subject, await pathResolver(subject));
      } catch {
        // Leave unset: an unresolvable subject preserves BLOCKING, same as a fetch failure.
      }
    }
  }

  return applyStructuralClaimVerification(toolCalls, fileContents, resolvedPaths);
}
