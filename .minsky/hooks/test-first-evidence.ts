// ---------------------------------------------------------------------------
// mt#3244: test-first evidence for bugfix-shaped PRs (CALIBRATION-FIRST, log-only)
// ---------------------------------------------------------------------------
//
// Closes two holes the execution-evidence gate has by construction:
//
//   Hole 2 — the TRIGGER set is blind to the shape of a bugfix. `findNewTestFiles`
//   counts only `added`/`renamed`/`copied`, so a bugfix that MODIFIES an existing
//   test file — the ordinary shape of a bugfix — falls outside the gate entirely
//   and is never asked for evidence of any kind.
//
//   Hole 3 — the STANDARD stops at "the test ran". A test written after the fix and
//   shaped to it passes, so "it ran and passed" is compatible with the test having
//   been incapable of failing. mem#704: "Before treating a probe's output as
//   evidence, establish that the broken state would produce a different output. If
//   it wouldn't, the probe carries zero information." A test is a probe of the fix;
//   "write the failing test first" is its negative control.
//
// Everything here is ADDITIVE and log-only, per the mt#2263 calibration ladder and
// exactly mirroring `./success-criteria-coverage` (mt#3350). It never influences
// `checkExecutionEvidence` — the file-pattern BLOCKING floor in
// `./require-execution-evidence-before-merge` — and never produces a `deny`.
// Graduation to blocking is a separate task, filed at the end of the calibration
// window once the false-positive rate is measured.
//
// @see mt#3244 — this addition; mt#1459 (the gate); mt#2263 (calibration ladder);
//      mem#704 (the negative-control rule this applies to the TEST artifact class)

// ## Why this module does not import the evidence hook
//
// `require-execution-evidence-before-merge.ts` imports THIS module to run the calibration,
// so an import back would be an ESM cycle and would put that hook's entry point at the mercy
// of module-evaluation order. Text this module needs therefore flows IN as a parameter
// rather than being re-extracted here, and the shared pieces come from dependency-free
// siblings. This mirrors `success-criteria-coverage.ts`'s section of the same name verbatim —
// PR #2462 R1 caught this module violating that established pattern.
//
// As of mt#3584 the only text it needs is the FULL PR body: the negative-control label is
// matched anywhere in it, so the extracted `Execution evidence:` block is no longer passed.
// Sibling surfaces (AT- and SC-coverage) still scope themselves to that block; this one
// deliberately does not — see `checkTestFirstEvidence`.
//
// @see .minsky/hooks/markdown-sections.ts — shared fence-aware primitives
// @see .minsky/hooks/pr-file-predicates.ts — `isTestFile`, moved there for this reason

import { computeFenceInternalLines, isMarkdownHeading } from "./markdown-sections";
import { isTestFile } from "./pr-file-predicates";
import { captureArtifact, CAPTURE_SCHEMA_VERSION } from "./judged-input-capture";
import type { ArtifactCapture } from "./judged-input-capture";
import type { PrFile } from "./pr-context";

// ---------------------------------------------------------------------------
// Hole 2 — the trigger set
// ---------------------------------------------------------------------------

/**
 * Test files this PR MODIFIES — precisely the set `findNewTestFiles` excludes.
 *
 * `findNewTestFiles` is deliberately scoped to newly-introduced artifacts, which is
 * correct for its own question ("was this new artifact ever exercised?"). It is the
 * wrong set for "was this bugfix's test capable of failing?", because editing an
 * existing test is the ordinary way a bugfix is tested.
 */
export function findModifiedTestFiles(files: PrFile[]): string[] {
  return files
    .filter((f) => f.status === "modified" && isTestFile(f.filename))
    .map((f) => f.filename);
}

/**
 * True when the PR title carries a bugfix conventional-commit type.
 *
 * Anchored at the start so the type is the TITLE's type, not a word inside the
 * description — `feat(mt#1): add a fix-it button` is a feature, not a bugfix. The
 * optional `!` covers the breaking-change form (`fix!:`).
 */
export function isBugfixShapedTitle(prTitle: string): boolean {
  return /^\s*(?:fix|bugfix)(?:\([^)]*\))?!?\s*:/i.test(prTitle);
}

/**
 * Second half of the bugfix-shaped signal, read off the bound task's spec.
 *
 * DELIBERATELY CONSERVATIVE. A miss here is a false NEGATIVE (a real bugfix goes
 * unflagged), which is the safe direction while this surface is calibrating — a
 * false POSITIVE trains readers to discount the detector's true positives, which is
 * the mem#719 failure mode this whole gate family keeps re-learning. The title
 * signal above carries most of the weight; this is a supplement, not a substitute.
 */
export function specDescribesDefect(specContent: string): boolean {
  return /\b(?:bug|defect|regression|broken|breaks|fails?|failing|drops?|dropped|swallow(?:s|ed)?|deadlocks?|incorrect(?:ly)?|silently|never (?:fires|runs|ran))\b/i.test(
    specContent
  );
}

// ---------------------------------------------------------------------------
// Hole 3 — the negative-control record
// ---------------------------------------------------------------------------

/** The bare phrase, with no delimiter or placement requirement. Used ONLY to tell
 *  "no negative control was recorded" apart from "one was recorded in a shape this
 *  matcher does not accept" (mt#3511) — never to decide that evidence is present. */
const NEGATIVE_CONTROL_PHRASE = /negative control|failing[- ]first/i;

/**
 * Form A — a Markdown heading naming the record: `## Negative control`,
 * `### Failing-first run:`. Trailing colon OPTIONAL, because the heading itself is
 * already an unambiguous structural marker.
 */
const NEGATIVE_CONTROL_HEADING =
  /^ {0,3}(#{1,6})\s+(?:negative control|failing[- ]first(?:\s+run)?)\b[^\n]*$/i;

/**
 * Form B — a label line. A DELIMITER is required so that bare prose mentioning the
 * phrase ("we should add a negative control here") does not false-positive. Two
 * delimiters are accepted:
 *
 *   - a colon — `Negative control:`
 *   - an em or en dash — `Negative control — telegram-transport.ts (3 poller tests)`
 *
 * The dash form was added by mt#3511. It is not a stylistic nicety: when a PR records
 * SEVERAL negative controls, each needs a subject after the label, and
 * `Negative control: telegram-transport.ts (...)` reads as a sentence fragment where
 * the dash reads as a heading. PR #2508 carried five real negative controls written
 * that way and the gate reported zero — the exact false-negative class mem#719 warns
 * erodes trust in a detector's true positives.
 *
 * A parenthetical between the phrase and the delimiter stays allowed, because the
 * useful form states the method inline: `Negative control (fix reverted, test run
 * against the un-fixed tree):`. `[^:\n]*?` permits that without letting the match
 * wander across lines.
 */
/**
 * How much text may precede the phrase on a label line (mt#3778).
 *
 * The anchor is relaxed, NOT removed. Writers tie each control to the criterion
 * it belongs to — `sc3 — negative control:`, `AT4: negative control — …`,
 * `sc2/sc3 negative control:` — and the strictly-anchored pattern rejected every
 * one of those, which is how a PR body carrying a real control logged as
 * carrying none.
 *
 * A BOUND is kept because this pattern's two failure directions are not
 * symmetric. Failing to match a real control is noise: the author sees a warning
 * they can dismiss. Matching prose that is NOT a control is worse — it records a
 * control that does not exist, and the whole point of the check is that a test
 * which cannot fail looks exactly like one that can. So the prefix is capped at
 * a label-sized span rather than opened to arbitrary prose, and the delimiter
 * after the phrase is still required.
 */
const LABEL_PREFIX_MAX_CHARS = 24;

/**
 * What may sit between the start of the line and the phrase (PR #2680 R1).
 *
 * Two shapes only, because a bare whitespace separator admitted ordinary prose:
 * `Consider a negative control: maybe later` and `TODO add negative control`
 * both matched, which is the dangerous direction — recording a control that
 * does not exist.
 *
 *   - a STRUCTURAL separator: `AT4:`, `sc3 —`, `Step 2 —`, `(3)`
 *   - a SINGLE bare token: `sc2/sc3 `, `sc3 ` — one word, no spaces inside, so
 *     `Consider a ` and `I ran a ` cannot qualify
 *
 * A criterion reference is a token or a token plus a separator. A sentence is
 * neither.
 */
const LABEL_PREFIX = `(?:[^\\s\\n]{1,${LABEL_PREFIX_MAX_CHARS}}\\s+|[^\\n]{0,${LABEL_PREFIX_MAX_CHARS}}?[:—–)]\\s*)`;

const NEGATIVE_CONTROL_LABEL = new RegExp(
  `^ {0,3}(?:${LABEL_PREFIX})?(?:negative control|failing[- ]first(?:\\s+run)?)\\b([^:\\n]*?)(?::|\\s[—–]\\s)(.*)$`,
  "i"
);

/**
 * Form C — the phrase introduced by a PREFIX separator and terminated by the end
 * of the line: `sc3 — negative control.`, `AT4: failing-first run`.
 *
 * Forms A/B both assume the delimiter FOLLOWS the phrase. This shape puts it
 * BEFORE — the dash separates the criterion from the label — and then the line
 * simply ends, with the evidence on the lines beneath. It is what PR #2565
 * actually wrote, and neither existing form can match it however far the prefix
 * allowance is widened, because there is no trailing delimiter to find.
 *
 * Treated exactly like a heading: no inline content is captured, so the
 * content-beneath requirement in {@link hasNegativeControlEvidence} still has to
 * be satisfied. A bare `sc3 — negative control.` with nothing under it is not a
 * record, which is what keeps this from becoming a way to claim a control by
 * writing its name.
 */
/**
 * Inline content that ASSERTS ABSENCE rather than describing a run (PR #2680 R1).
 *
 * Anchored to the whole trimmed content, not a substring search: `none` alone
 * means no control, while `none of the three retries fired` is a real
 * description of what failed. Matching the former and not the latter is the
 * entire distinction.
 */
const ABSENCE_ONLY_CONTENT =
  /^(?:none|n\/?a|nil|no|not\s+run|not\s+applicable|skipped?|omitted|absent|todo|tbd|pending)\b(?:\s+(?:recorded|needed|required|applicable|available|yet|here|this\s+time))?[\s.!—–-]*$/i;

const NEGATIVE_CONTROL_PREFIXED_LABEL = new RegExp(
  `^ {0,3}${LABEL_PREFIX}(?:negative control|failing[- ]first(?:\\s+run)?)\\b[.:]?\\s*$`,
  "i"
);

/**
 * Strip decoration a writer puts AROUND the label, so the matcher sees the label.
 *
 * `- **Negative control — foo**` and `**Negative control:**` are the same record as
 * `Negative control:`; before mt#3511 neither matched, because the pattern is anchored
 * and a leading `*` or `-` is not the phrase. Heading hashes are PRESERVED — form A
 * depends on them.
 *
 * Only OPENING decoration is stripped. A trailing `**` survives into the content,
 * which is harmless: it is content either way.
 */
function stripLabelDecoration(line: string): string {
  // Emphasis is stripped from BOTH ends (mt#3778). Leading-only was enough while
  // every accepted form ended in a delimiter mid-line; Form C ends AT the line
  // end, so a closing `**` sits exactly where the pattern looks for the end and
  // silently defeats it — `**sc3 — negative control.**` is the shape PR #2565
  // wrote and the reason this stripper is symmetric now.
  const stripTrailingEmphasis = (s: string): string => s.replace(/(?:\*\*|__|\*|_)+\s*$/, "");
  const heading = line.match(/^( {0,3}#{1,6}\s+)([\s\S]*)$/);
  if (heading) {
    return `${heading[1] ?? ""}${stripTrailingEmphasis((heading[2] ?? "").replace(/^(?:\*\*|__|\*|_)+/, ""))}`;
  }
  return stripTrailingEmphasis(
    line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/, "").replace(/^ {0,3}(?:\*\*|__|\*|_)+/, "")
  );
}

/**
 * True when the text MENTIONS a negative control anywhere — including inside a fence,
 * without a delimiter, in any decoration. Deliberately far looser than the matcher.
 *
 * This exists to make the gate's own false negatives measurable (mt#3511). A record
 * that reports "absent" when it means "present but unmatched" makes a formatting
 * mismatch indistinguishable from a real missing control, which is why the class
 * recurred four times before anyone could count it.
 */
export function mentionsNegativeControl(text: string): boolean {
  return NEGATIVE_CONTROL_PHRASE.test(text.replace(/<!--[\s\S]*?-->/g, ""));
}

/**
 * One negative-control record: the marker line, plus the text belonging to it.
 *
 * The BODY is what a provenance check needs (mt#4044) — it carries the subject
 * the control was run against, which is the only thing that distinguishes a
 * control that ran from the ordinary red test runs any session produces.
 */
export interface NegativeControlRecord {
  /** The marker line with its decoration stripped, as the matcher saw it. */
  label: string;
  /** Inline content plus the lines beneath, up to the next real heading. */
  body: string;
}

/**
 * Every negative-control record in `text`, in document order.
 *
 * Extracted from {@link hasNegativeControlEvidence}, which is now a wrapper over
 * it, so the two cannot drift: the accepted forms, the fence rule, the negation
 * guard and the absence-only rule are stated ONCE. mt#4044 needed the record's
 * text rather than a boolean and the corpus rule is to consume the existing
 * matcher rather than author a second one — a second matcher is how a widening
 * on one surface silently fails to reach the other.
 */
export function extractNegativeControlRecords(text: string): NegativeControlRecord[] {
  const found: NegativeControlRecord[] = [];
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  // Fence-aware, per mt#3277/mt#3316: an evidence block IS a pasted shell transcript, so it
  // legitimately contains both `# comment` lines (which look like headings) and, when a PR
  // pastes example markdown, the marker phrase itself. Treating a fenced line as a heading
  // truncates the content scan; treating a fenced marker as real is a false positive. Both
  // are the exact class the sibling scanners already fixed — reuse their primitive rather
  // than re-deriving it (PR #2462 R1).
  const fenceInternal = computeFenceInternalLines(lines);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    // A marker inside a fence is quoted text, not a record. This is what makes the
    // marker line's PLACEMENT load-bearing — see the message in `checkTestFirstEvidence`,
    // which must keep saying so (mt#3506, folded into mt#3511 as instance 2).
    if (fenceInternal[i]) continue;

    const line = stripLabelDecoration(raw);
    // Form C is checked alongside the heading, not the label: like a heading it
    // captures no inline content, so it falls through to the content-beneath
    // scan below rather than being satisfied by the line itself.
    const headingMatch =
      line.match(NEGATIVE_CONTROL_HEADING) ?? line.match(NEGATIVE_CONTROL_PREFIXED_LABEL);
    const labelMatch = headingMatch ? null : line.match(NEGATIVE_CONTROL_LABEL);
    if (!headingMatch && !labelMatch) continue;

    // Negation guard — "No negative control: n/a" must not count as a record.
    //
    // mt#3778 promoted this from defence-in-depth to load-bearing. It used to be
    // belt-and-braces: the pattern anchored the phrase at line start, so nothing
    // could precede it and a leading "No" already failed to match. Now that a
    // label-sized prefix IS allowed, this guard is the thing standing between
    // `sc3 — negative control:` (a record) and `sc3 — no negative control:` (the
    // opposite claim), so it also covers the other ways a writer says absent.
    const lower = line.toLowerCase();
    const phraseIdx = Math.max(lower.indexOf("negative control"), lower.indexOf("failing"));
    const beforeMarker = phraseIdx > 0 ? lower.slice(0, phraseIdx) : "";
    if (/\b(no|not|without|missing|skipped?|lacks?|omitted)\b/.test(beforeMarker)) continue;

    // The record's BODY: whatever follows the marker, up to the next real
    // heading. Collected for every marker — including the ones the checks below
    // reject — but only PUSHED once a record qualifies, so the boolean wrapper's
    // verdict is byte-for-byte what it was before this was factored out.
    const beneath: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined) break;
      if (!fenceInternal[j] && isMarkdownHeading(nextLine)) break;
      beneath.push(nextLine);
    }
    const hasContentBeneath = beneath.some((l) => l.trim().length > 0);
    const record = (inline: string): NegativeControlRecord => ({
      label: line,
      body: [inline, ...beneath].filter((l) => l.length > 0).join("\n"),
    });

    const inlineContent = (labelMatch?.[2] ?? "").trim();
    // The inline content must SAY something, not say there is nothing (PR #2680
    // R1). The guard above reads only the text BEFORE the phrase, so it catches
    // `No negative control: …` and misses `Negative control: none` — the same
    // claim with the negation on the other side of the delimiter. This hole
    // predates the prefix work; it is fixed here because it is the same class,
    // and because an absence marker recorded as a present control is precisely
    // the reading this whole check exists to prevent.
    if (inlineContent.length > 0) {
      if (ABSENCE_ONLY_CONTENT.test(inlineContent)) continue;
      found.push(record(inlineContent));
      continue;
    }

    // Only a REAL heading ends the section — a `# revert the fix` comment inside
    // the pasted transcript is content, not a boundary (applied when `beneath`
    // was collected above).
    if (hasContentBeneath) found.push(record(""));
  }

  return found;
}

/**
 * True when `text` records a run observed FAILING against the un-fixed tree.
 *
 * Structure mirrors `hasExecutionEvidence`: find a marker line, reject negations,
 * then require non-whitespace content either inline or on a following line before
 * the next heading. A marker with nothing after it is a promise, not a record.
 */
export function hasNegativeControlEvidence(text: string): boolean {
  return extractNegativeControlRecords(text).length > 0;
}

/**
 * The deferral marker is NUMBERED to a tracking task, matching mt#3350's
 * `[scN-deferred: mt#NNNN]` convention — prose explaining why the negative control
 * was skipped reads as coverage to a human and as nothing to the gate.
 */
const NEGATIVE_CONTROL_DEFERRAL = /\[negative-control-deferred:\s*(mt#\d+)\]/i;

/** Returns the deferral marker's task id, or null when no well-formed marker is present. */
export function extractNegativeControlDeferral(prBody: string): string | null {
  const match = prBody.match(NEGATIVE_CONTROL_DEFERRAL);
  return match?.[1] ?? null;
}

/** True when the PR body carries a well-formed negative-control deferral marker. */
export function isNegativeControlDeferred(prBody: string): boolean {
  return extractNegativeControlDeferral(prBody) !== null;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Result of the test-first check.
 *
 * Deliberately carries NO `blocked` field. This surface is log-only and the absence
 * of the field is the structural guarantee — a future caller cannot accidentally
 * read a blocking verdict off it, and the omission is pinned by a test.
 */
export interface TestFirstEvidenceResult {
  /** Did the PR present as a bugfix (title type, or the bound spec describing a defect)? */
  bugfixShaped: boolean;
  /** Test files modified by this PR — the set the blocking floor ignores. */
  modifiedTestFiles: string[];
  /** bugfixShaped AND at least one modified test file. */
  requiresNegativeControl: boolean;
  /** Whether the evidence block records a run observed failing pre-fix. */
  negativeControlPresent: boolean;
  /**
   * The evidence MENTIONS a negative control but no marker matched (mt#3511).
   *
   * Splits the flagged population into two kinds that were previously indistinguishable:
   * a genuinely missing control, and one written in a shape the matcher rejects. Without
   * this, every widening is argued from anecdote — four instances of the class landed
   * before anyone could measure its rate.
   */
  negativeControlUnmatched: boolean;
  /** Tracking task id from a `[negative-control-deferred: mt#N]` marker, if present. */
  deferralMarker: string | null;
  /** Required, absent, and not deferred. */
  flagged: boolean;
  /** Human-readable explanation, present only when flagged. */
  reason?: string;
}

/**
 * Run the test-first check. Pure — injectable for tests, no I/O.
 *
 * `specContent` is optional: the title signal alone is sufficient to fire, and the
 * caller may not have a bound spec.
 */
export function checkTestFirstEvidence(
  prFiles: PrFile[],
  prTitle: string,
  prBody: string,
  specContent?: string | null
): TestFirstEvidenceResult {
  const modifiedTestFiles = findModifiedTestFiles(prFiles);
  const bugfixShaped =
    isBugfixShapedTitle(prTitle) ||
    (typeof specContent === "string" && specContent.length > 0
      ? specDescribesDefect(specContent)
      : false);

  const requiresNegativeControl = bugfixShaped && modifiedTestFiles.length > 0;
  if (!requiresNegativeControl) {
    return {
      bugfixShaped,
      modifiedTestFiles,
      requiresNegativeControl: false,
      negativeControlPresent: false,
      negativeControlUnmatched: false,
      deferralMarker: null,
      flagged: false,
    };
  }

  // Scanned over the WHOLE body, not the extracted `Execution evidence:` block
  // (mt#3584). Two reasons, and the second is why the first matters:
  //
  //   1. `deferralMarker` on the next line already resolves against `prBody`.
  //      Nothing about the label justifies a narrower window than its own
  //      deferral marker, and the split silently made placement load-bearing in
  //      a way no author could see.
  //   2. The accepted-forms message below states only the FENCE rule. An author
  //      who put a well-formed label immediately above the `Execution evidence:`
  //      heading satisfied every stated constraint and was warned anyway —
  //      twice, on PR #2531 and PR #2553, with labels the matcher accepts when
  //      handed them. Those fires wrote calibration records claiming no control
  //      was present, which is the data this surface's graduate/tune decision
  //      rests on (mem#719).
  //
  // Widening rather than re-documenting is deliberate: mt#3511 already tried the
  // prose route on this exact paragraph and, in removing an ambiguous block
  // requirement, left the requirement enforced and unstated.
  const negativeControlPresent = hasNegativeControlEvidence(prBody);
  const negativeControlUnmatched = !negativeControlPresent && mentionsNegativeControl(prBody);
  const deferralMarker = extractNegativeControlDeferral(prBody);
  const flagged = !negativeControlPresent && deferralMarker === null;

  const result: TestFirstEvidenceResult = {
    bugfixShaped,
    modifiedTestFiles,
    requiresNegativeControl: true,
    negativeControlPresent,
    negativeControlUnmatched,
    deferralMarker,
    flagged,
  };

  if (flagged) {
    // The accepted-forms paragraph is the ONLY place most authors ever learn the
    // convention, so it must state the PLACEMENT rule the matcher actually enforces —
    // ALL of it. Two instances of it failing to (mt#3506 / mt#3511, then mt#3584):
    //
    //   - "Accepted forms inside the `Execution evidence:` block" read as "inside the
    //     fence," the one placement that can never match, because a fenced marker is
    //     treated as quoted text.
    //   - Dropping the block requirement to fix that left the matcher still enforcing
    //     it, so a label placed just above the block satisfied every stated rule and
    //     was warned anyway.
    //
    // mt#3584 removed the block requirement from the MATCHER rather than adding it
    // back here, so there is now exactly one rule to state: not inside a fence.
    // Keep it that way — if a future change re-narrows the scan window, this
    // paragraph has to regain the second rule in the same commit.
    const acceptedForms =
      `Accepted forms (case-insensitive), on their own line NOT inside a code fence — ` +
      `anywhere in the PR body; placement relative to the \`Execution evidence:\` block ` +
      `does not matter, though next to the run output reads best:\n` +
      `  - \`Negative control: <what you reverted and what failed>\`\n` +
      `  - \`Negative control — <subject>\` (em or en dash; use this when a PR has several)\n` +
      `  - \`Failing-first:\` in either form, or a Markdown heading naming either.\n` +
      `  - A criterion prefix is fine: \`sc3 — negative control:\`, \`AT4: negative control — <subject>\`, ` +
      `or \`sc3 — negative control.\` with the run beneath it (mt#3778).\n` +
      `Surrounding \`**bold**\` and a leading \`-\` bullet are fine. The failing run itself ` +
      `MAY be fenced beneath the label — only the label line has to be outside.\n` +
      `If it genuinely cannot be run pre-merge, use ` +
      `\`[negative-control-deferred: mt#NNNN]\` naming a tracking task.`;

    // Distinguish "absent" from "present but unmatched" in the operator-facing text
    // as well as in the calibration record — the whole point of mt#3511.
    const lead = negativeControlUnmatched
      ? `This PR is bugfix-shaped and modifies ${modifiedTestFiles.length} existing test ` +
        `file(s). Its body MENTIONS a negative control, but no marker matched — ` +
        `so this is most likely a FORMATTING mismatch, not a missing control. Check the ` +
        `accepted forms below before treating it as a real gap.`
      : `This PR is bugfix-shaped and modifies ${modifiedTestFiles.length} existing test ` +
        `file(s), but its body records no negative control — no run observed FAILING ` +
        `against the un-fixed tree.`;

    result.reason =
      `${lead}\n\n` +
      `A test that passes both with and without the fix carries no information about ` +
      `the fix (mem#704). Revert the fix (or stub the condition), run the changed ` +
      `test, and paste the failure alongside the passing run.\n\n` +
      `Modified test file(s):\n${modifiedTestFiles.map((f) => `  - ${f}`).join("\n")}\n\n${
        acceptedForms
      }`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Calibration plumbing (mirrors ./success-criteria-coverage)
// ---------------------------------------------------------------------------

/** Documented escape hatch. Registered in `HOOK_ONLY_ENV_VARS` per mt#1788. */
export const TEST_FIRST_SKIP_ENV_VAR = "MINSKY_SKIP_TEST_FIRST_EVIDENCE";

/** Stream name — the SINGLE source of truth (mt#4755); the path below is DERIVED from it. */
export const TEST_FIRST_STREAM = "execution-evidence-test-first";

/** Calibration log, sibling of the AT- and SC-coverage logs. Derived from the stream name. */
export const TEST_FIRST_CALIBRATION_LOG = `.minsky/${TEST_FIRST_STREAM}-calibration.jsonl`;

export function isTestFirstSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[TEST_FIRST_SKIP_ENV_VAR];
  return v === "1" || v === "true" || v === "yes";
}

/**
 * One calibration record. `decision` is always `warn` — this surface never denies.
 *
 * Declared as a `type`, not an `interface`, deliberately: `appendCalibrationRecord` takes a
 * `Record<string, unknown>`, and TypeScript gives object type ALIASES an implicit index
 * signature while interfaces get none — an interface here fails to typecheck at the call site.
 */
export type TestFirstCalibrationRecord = {
  timestamp: string;
  task: string;
  prNumber: number | null;
  decision: "warn";
  modifiedTestFiles: string[];
  bugfixShaped: boolean;
  negativeControlPresent: boolean;
  /** True when the evidence mentions a negative control that no marker matched (mt#3511).
   *  This is the field that makes the gate's own false-negative rate countable — a
   *  `/calibration-review` sweep can now separate formatting misses from real gaps. */
  negativeControlUnmatched: boolean;
  deferralMarker: string | null;
  /** Capture-schema marker (mt#3607) — absent on every record written before capture landed. */
  captureSchema: number;
  /** The PR title, one of the two signals `bugfixShaped` is derived from. */
  prTitle: string;
  /**
   * The PR body this verdict was computed against (mt#3607).
   *
   * The reason this surface needed capture more than any other: its verdict
   * turns on WHERE text sits, and its input is MUTABLE. mt#3584 found PR #2531
   * recorded as a fire when the negative-control label sat above the evidence
   * block, then edited so the label sat inside it — re-running the matchers over
   * the CURRENT body reports it clean, and the historical false positive becomes
   * invisible. A record that carries the body it judged is re-classifiable no
   * matter what the body says later; `hash` makes the mutation itself visible.
   *
   * NOT elided, unlike the turn-text surfaces. The matchers' answers depend on
   * fence membership — mt#3511's whole finding is that a FENCED negative-control
   * label does not count — so blanking fenced spans would destroy exactly the
   * structure a re-derivation needs. The exposure trade is acceptable here and
   * not elsewhere: a PR body is already public on the forge, and this log is
   * machine-local (`.gitignore:56`).
   */
  judgedPrBody: ArtifactCapture;
  /**
   * The bound task's spec, or null when the caller had none.
   *
   * Captured alongside the body because `bugfixShaped` has TWO sources — the
   * title and the spec — so a record carrying only the body can re-derive the
   * negative-control half of the verdict but not the trigger half. Both, and the
   * whole verdict re-derives from the record with no fetch.
   */
  judgedSpec: ArtifactCapture | null;
};

export interface TestFirstCalibrationRunResult {
  /** False when the documented override suppressed the check. */
  ranCheck: boolean;
  /** WARN string for `additionalContext`, or null when nothing to report. */
  warning: string | null;
  /** Record to append, or null when the PR is compliant / not applicable. */
  calibrationRecord: TestFirstCalibrationRecord | null;
}

/**
 * Runs the test-first calibration surface for one merge attempt.
 *
 * Never denies; the caller appends `calibrationRecord` and pushes `warning` onto the
 * same aggregated `additionalContext` the AT- and SC-coverage surfaces use.
 */
export function runTestFirstCalibration(
  task: string,
  prNumber: number | null,
  prFiles: PrFile[],
  prTitle: string,
  prBody: string,
  specContent: string | null,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): TestFirstCalibrationRunResult {
  if (isTestFirstSkipped(env)) {
    return { ranCheck: false, warning: null, calibrationRecord: null };
  }

  const result = checkTestFirstEvidence(prFiles, prTitle, prBody, specContent);
  if (!result.flagged) {
    return { ranCheck: true, warning: null, calibrationRecord: null };
  }

  const warning =
    `[execution-evidence-test-first] CALIBRATION (log-only, mt#3244 — would block if ` +
    `graduated): ${result.reason}\n\n` +
    `Merge is NOT blocked by this — it is a calibration signal only. Override: set ` +
    `${TEST_FIRST_SKIP_ENV_VAR}=1.`;

  return {
    ranCheck: true,
    warning,
    calibrationRecord: {
      timestamp: now().toISOString(),
      task,
      prNumber,
      decision: "warn",
      captureSchema: CAPTURE_SCHEMA_VERSION,
      prTitle,
      judgedPrBody: captureArtifact(prBody),
      judgedSpec: typeof specContent === "string" ? captureArtifact(specContent) : null,
      modifiedTestFiles: result.modifiedTestFiles,
      bugfixShaped: result.bugfixShaped,
      negativeControlPresent: result.negativeControlPresent,
      negativeControlUnmatched: result.negativeControlUnmatched,
      deferralMarker: result.deferralMarker,
    },
  };
}
