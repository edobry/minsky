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
const NEGATIVE_CONTROL_LABEL =
  /^ {0,3}(?:negative control|failing[- ]first(?:\s+run)?)\b([^:\n]*?)(?::|\s[—–]\s)(.*)$/i;

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
  const heading = line.match(/^( {0,3}#{1,6}\s+)([\s\S]*)$/);
  if (heading) {
    return `${heading[1] ?? ""}${(heading[2] ?? "").replace(/^(?:\*\*|__|\*|_)+/, "")}`;
  }
  return line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/, "").replace(/^ {0,3}(?:\*\*|__|\*|_)+/, "");
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
 * True when `text` records a run observed FAILING against the un-fixed tree.
 *
 * Structure mirrors `hasExecutionEvidence`: find a marker line, reject negations,
 * then require non-whitespace content either inline or on a following line before
 * the next heading. A marker with nothing after it is a promise, not a record.
 */
export function hasNegativeControlEvidence(text: string): boolean {
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
    const headingMatch = line.match(NEGATIVE_CONTROL_HEADING);
    const labelMatch = headingMatch ? null : line.match(NEGATIVE_CONTROL_LABEL);
    if (!headingMatch && !labelMatch) continue;

    // Negation guard — "No negative control: n/a" must not count as a record. Both
    // patterns anchor the phrase at line start, so a preceding "No" already fails to
    // match; this stays as defense-in-depth against a future loosening of the anchor.
    const lower = line.toLowerCase();
    const phraseIdx = Math.max(lower.indexOf("negative control"), lower.indexOf("failing"));
    const beforeMarker = phraseIdx > 0 ? lower.slice(0, phraseIdx) : "";
    if (/\bno\b/.test(beforeMarker)) continue;

    const inlineContent = (labelMatch?.[2] ?? "").trim();
    if (inlineContent.length > 0) return true;

    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined) break;
      // Only a REAL heading ends the section — a `# revert the fix` comment inside the
      // pasted transcript is content, not a boundary.
      if (!fenceInternal[j] && isMarkdownHeading(nextLine)) break;
      if (nextLine.trim().length > 0) return true;
    }
  }

  return false;
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

/** Calibration log, sibling of the AT- and SC-coverage logs. */
export const TEST_FIRST_CALIBRATION_LOG = ".minsky/execution-evidence-test-first-calibration.jsonl";

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
