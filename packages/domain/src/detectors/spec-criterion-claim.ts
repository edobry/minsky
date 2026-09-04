/**
 * Spec-criterion-claim matcher — mt#4153.
 *
 * `/plan-task`'s premise gates all fire on a claim that DRIVES a decision — (j) a
 * categorization label, (m) a cited passage justifying a structural choice, (o) a
 * runtime causal claim. A `## Success Criteria` bullet is none of those. It is the
 * claim the implementation is measured AGAINST, so a wrong one does not merely
 * mislead: it certifies the wrong thing as done, or blocks work that was already
 * authorized.
 *
 * Two classes, both machine-checkable, neither judging whether a criterion is WISE:
 *
 *   Class A — UNVERIFIED CORPUS-STATE ASSERTION. A criterion asserting present-tense
 *   existence about the repo ("`OVERRIDE_ENV_VAR` remains documented in CLAUDE.md").
 *   The word "remains" licenses a removal, and nothing had read the criterion as a
 *   claim. Silenced by an inline verifying command in the same criterion — a
 *   criterion that ships its own falsifier needs no reminder.
 *
 *   Class B — INVENTED PRECONDITION. A criterion imposing a conditional gate
 *   ("filed … once the ADR is accepted") whose condition does not appear in the
 *   task's authorizing source. This is the direction that BLOCKS authorized work:
 *   ask#8467's chosen option said "One decision record answering the seven open
 *   questions, then implementation subtasks" — acceptance appears nowhere in it, and
 *   the invented precondition nearly parked three ready subtasks.
 *
 * ## Why this lives in the domain package rather than in the hook
 *
 * ADR-024's Decision clause requires the guidance-hook ladder be "built on the
 * shared `packages/domain/src/detectors/` framework so all guidance hooks consume
 * one mechanism instead of divergent regex copies", so the matcher lives HERE and
 * `.minsky/hooks/` holds a thin adapter — the same split
 * {@link ../detectors/negative-existence-claim.ts} made for the same reason.
 *
 * ## Why the elider is INJECTED rather than imported
 *
 * ADR-024 §Rung 1 prescribes quotation-aware elision before matching, and the
 * canonical implementation is `elideMarkdownNonProse` in
 * `.minsky/hooks/block-out-of-band-merge.ts`. A domain module importing from the
 * hooks tree would invert the layering — hooks adapt the domain, not the reverse —
 * so {@link detectSpecCriterionClaims} takes the elider as a parameter and the hook
 * supplies that exact function. Reuse without inversion; no second elision copy.
 *
 * ## Rung placement
 *
 * Rung 1, on the merits: a phrase match, a same-criterion command check, and an
 * exact-substring lookup against an ask's chosen option are all deterministic. Do
 * NOT answer a paraphrase miss by widening {@link CLASS_A_PATTERNS} — that is the
 * arms race ADR-024's `## Context` exists to end. No similarity metric appears here
 * deliberately: per mem#819 a true duplicate measured 1.027 against a 0.65
 * threshold, so similarity provably cannot discriminate at these distances.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see .minsky/hooks/spec-criterion-claim-detector.ts — the adapter
 */

/** The two spec sections whose bullets are claims the work is measured against. */
export const SCANNED_SECTIONS: readonly string[] = ["Success Criteria", "Acceptance Tests"];

/**
 * Class A triggers: present-tense assertions that the repo ALREADY contains
 * something.
 *
 * Deliberately small and anchored on word boundaries. The discriminating power is
 * not the phrase family — it is that a criterion is asserting current corpus state
 * without shipping the one-line check that would settle it.
 */
export const CLASS_A_PATTERNS: readonly RegExp[] = [
  /\bremains?\b/i,
  /\bstill\b/i,
  /\balready\b/i,
  /\bcontinues to\b/i,
  /\bis documented\b/i,
  /\bis registered\b/i,
  /\bis wired\b/i,
];

/**
 * Class B triggers: conditional gates, each capturing the token whose presence in
 * the authorizing source decides the verdict.
 *
 * For the `once … is <state>` and `after … <approves>` forms the load-bearing token
 * is the STATE, not the entity: R2's ask does contain "decision record" (≈ the ADR)
 * and does NOT contain "accepted", so keying on the entity would have missed it and
 * keying on the state catches it. For `pending` / `contingent on` / `gated on` the
 * condition IS the object, so the captured phrase is checked instead.
 */
export const CLASS_B_PATTERNS: readonly { pattern: RegExp; kind: "state" | "object" }[] = [
  { pattern: /\bonce\b[^.;]{0,80}?\bis\s+(accepted|approved|merged|done)\b/i, kind: "state" },
  { pattern: /\bafter\b[^.;]{0,80}?\b(approves|accepts|merges)\b/i, kind: "state" },
  { pattern: /\bpending\s+([^.;,)]{3,60})/i, kind: "object" },
  { pattern: /\bcontingent on\s+([^.;,)]{3,60})/i, kind: "object" },
  { pattern: /\bgated on\s+([^.;,)]{3,60})/i, kind: "object" },
];

/**
 * Command leaders that make a backticked span in a criterion a VERIFYING command —
 * the thing that turns an assertion into a check and silences Class A.
 */
export const VERIFY_COMMAND_LEADERS: readonly string[] = [
  "grep",
  "rg",
  "ag",
  "ack",
  "ugrep",
  "wc",
  "find",
  "ls",
  "jq",
  "test",
  "bun",
  "git",
];

/**
 * A CORPUS REFERENT — the second conjunct Class A needs, added after measurement.
 *
 * The trigger vocabulary alone does not discriminate. Measured over the 120
 * most-recently-updated real specs (1,102 criteria): phrase-only matching fired on
 * **83 of 120 (69.2%)**, because `still`, `already` and `remains` are ordinary
 * English adverbs. Samples from that run: "it **still** reaches PASS with…", "a
 * deviation justified by a claim about a consumer… **already**". None asserts
 * anything about the repo. Adding this conjunct takes it to **61 (50.8%)**.
 *
 * That figure was first measured at 47 (39.2%) and the difference was a BUG in this
 * conjunct, not a property of the corpus: {@link hasCorpusReferentNear} treated a
 * newline as a sentence end, so every criterion wrapped between its trigger and its
 * referent was a false negative (PR #3063 R1). A quarter of the apparent improvement
 * was the conjunct silently suppressing true positives. Worth stating plainly,
 * because the honest reading is that the referent requirement helps LESS than the
 * first measurement suggested.
 *
 * Sample the RECENT specs, not the oldest — the same run measured the 120 oldest by
 * id at 32.5% phrase-only, half the recent rate, because the dense-prose spec style
 * that uses these adverbs is recent. This hook fires on `tasks_create` /
 * `tasks_spec_patch`, so newly-written specs are the population it actually faces
 * and an id-ordered corpus understates its load by 2x.
 *
 * What every real instance has and those do not is a thing IN THE CORPUS that the
 * assertion is about: `` `OVERRIDE_ENV_VAR` remains documented in `CLAUDE.md` ``.
 * So Class A now requires a referent in the SAME SENTENCE as the trigger — a
 * backticked span, or a corpus-file name / path-shaped token.
 *
 * Read from the RAW sentence, like {@link hasInlineVerifyingCommand} and for the
 * same reason: a backticked identifier is a code span, which elision blanks.
 *
 * This is a NARROWING driven by a measurement, not a widening chasing recall — the
 * arms race ADR-024 §Context exists to end runs the other way.
 */
const CORPUS_REFERENT_PATTERNS: readonly RegExp[] = [
  /`[^`\n]+`/, // a backticked identifier, path, or env var
  /\b[A-Z][A-Za-z0-9_-]*\.(?:md|mdc|ts|tsx|json|ya?ml)\b/, // CLAUDE.md, AGENTS.md
  /\b[a-z0-9_.-]+\/[a-z0-9_./-]+\.[a-z]+\b/i, // a path with a directory
  /\b[A-Z][A-Z0-9_]{4,}\b/, // a SCREAMING_SNAKE identifier
];

/** Tokens too common to discriminate a Class B object against a short option text. */
const OBJECT_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "been",
  "this",
  "that",
  "it",
  "its",
  "task",
  "tasks",
]);

/** Max chars of a criterion carried into a finding, so feedback stays bounded. */
export const CRITERION_EXCERPT_CAP = 160;

/**
 * The authorization a Class B precondition is checked against.
 *
 * Resolved from the ask(s) whose `parentTaskId` is the task being written: the
 * chosen option's label plus that option's description. Both are the operator's own
 * words; anything absent from them is the agent's addition.
 */
export interface AuthorizingSource {
  /** Short id of the ask, for the finding's evidence line. */
  askId: string;
  /** `response.payload.chosen` — the option the operator picked. */
  chosen: string;
  /** That option's `description`, which routinely carries the real constraint. */
  description: string;
}

/** One flagged criterion. */
export interface CriterionClaimFinding {
  /** Which scanned section the criterion came from. */
  section: string;
  /** The criterion, elided and capped. */
  criterion: string;
  /** `A` = unverified corpus-state assertion; `B` = invented precondition. */
  klass: "A" | "B";
  /** The trigger text, verbatim, so the author can recognize a false positive. */
  phrase: string;
  /** Class B only: the token checked against the authorizing source. */
  condition?: string;
  /** Class B only: the ask the condition was checked against. */
  askId?: string;
}

export interface SpecCriterionClaimResult {
  matched: boolean;
  findings: CriterionClaimFinding[];
  /** How many criteria were examined — the evaluation stream's denominator. */
  criteriaExamined: number;
  /**
   * Whether an authorizing source was available. Class B cannot fire without one:
   * an unlinked task has no machine-readable authorization to compare against, and
   * guessing is worse than silence.
   */
  authorizingSourceAvailable: boolean;
}

/** A criterion, kept in both forms because the two checks read different ones. */
interface ExtractedCriterion {
  section: string;
  /** Verbatim, including code spans — where a verifying command is visible. */
  raw: string;
  /** Elided, so a trigger quoted in a code span or blockquote cannot match. */
  elided: string;
}

/**
 * Pull the bullets out of the scanned sections.
 *
 * A criterion is a list item plus its indented continuation lines — criteria wrap,
 * and a trigger sitting on the second line of a bullet is the same claim as one on
 * the first. Section ends at the next `##`-or-shallower heading.
 *
 * ## Elision runs on the WHOLE spec, before structure is read
 *
 * This ordering is load-bearing rather than incidental, and getting it wrong was
 * caught by this module's own SC8 test. Eliding each criterion AFTER extracting it
 * cannot work: a fenced block containing `- [ ] \`FOO\` remains documented` — which
 * is exactly how these incidents get written up — parses as a bullet while the
 * fence markers sit on OTHER lines, so a per-criterion elide sees no fence and the
 * quoted example becomes a criterion. Eliding first blanks the fence's contents, so
 * the pseudo-bullet is gone before anything looks for structure.
 *
 * That works because `elideMarkdownNonProse` replaces elided spans with
 * SAME-LENGTH whitespace and preserves newlines: raw and elided share identical
 * line numbering, so structure can be read off the elided text while the RAW line
 * is still recoverable by index. The raw form is needed because a verifying command
 * lives in a code span the elision blanks — see {@link hasInlineVerifyingCommand}.
 */
export function extractCriteria(
  spec: string,
  elide: (text: string) => string
): ExtractedCriterion[] {
  const out: ExtractedCriterion[] = [];
  if (typeof spec !== "string" || spec.trim() === "") return out;

  const rawLines = spec.split("\n");
  const elidedLines = elide(spec).split("\n");

  let section: string | null = null;
  let indices: number[] = [];

  const flush = (): void => {
    if (section === null || indices.length === 0) return;
    const raw = indices.map((i) => rawLines[i] ?? "").join("\n");
    const elided = indices.map((i) => elidedLines[i] ?? "").join("\n");
    if (elided.trim() !== "") out.push({ section, raw, elided });
    indices = [];
  };

  for (let i = 0; i < elidedLines.length; i++) {
    const line = elidedLines[i] ?? "";

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const title = (heading[2] ?? "").replace(/[*`]/g, "").trim();
      section = SCANNED_SECTIONS.some((s) => title.toLowerCase().startsWith(s.toLowerCase()))
        ? title
        : null;
      continue;
    }
    if (section === null) continue;

    // A new list item ends the previous one; anything indented continues it.
    if (/^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(line)) {
      flush();
      indices.push(i);
      continue;
    }
    if (indices.length > 0 && (line.trim() === "" || /^\s+/.test(line))) {
      indices.push(i);
    } else if (indices.length > 0) {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Blank PROSE-QUOTED spans with same-length whitespace.
 *
 * SC7 requires elision of "markdown code spans, fenced blocks and blockquote lines
 * … plus prose-quoted spans". `elideMarkdownNonProse` covers the first three and
 * NOT this one, so this is the missing half rather than an extra: a criterion that
 * quotes the message it is about is example text, not an assertion about the repo.
 *
 * Measured need, not a hypothetical — a real Class A fire on the corpus run was
 * mt#4199's `A closing message saying "still with you: ask#N"`, where the trigger
 * sits inside a quoted sample string.
 *
 * Kept OUT of `elideMarkdownNonProse`: that function is shared by other guards
 * (`block-out-of-band-merge` scans PR bodies with it), and widening a shared elider
 * to serve this detector would silently change what those guards can see. The hook
 * composes the two instead.
 *
 * **MOVED to `../text/prose-elision.ts` by mt#4454** and re-exported here so this
 * module's consumers (`.minsky/hooks/spec-criterion-claim-detector.ts` imports it
 * from this path) are unchanged. It moved because a SECOND domain consumer appeared
 * — `../memory/staleness.ts` — and a shared Rung-1 primitive should not live inside
 * one detector's module. Same-length replacement still preserves the offset
 * alignment {@link hasCorpusReferentNear} depends on.
 */
export { elideProseQuotedSpans } from "../text/prose-elision";

/**
 * Whether a criterion ships its own falsifier.
 *
 * Read from the RAW criterion on purpose: a verifying command lives inside a code
 * span, which elision blanks. So the silencer is looked for before elision and the
 * triggers after it — the two checks deliberately read different forms of the same
 * text.
 */
export function hasInlineVerifyingCommand(rawCriterion: string): boolean {
  const spans = rawCriterion.match(/`+([^\n]+?)`+/g);
  if (spans === null) return false;
  for (const span of spans) {
    // Strip a shell prompt BEFORE splitting, not after: in `$ rg FOO` the `$` is
    // its own token, so stripping it from token[0] leaves an empty leader and the
    // command goes unrecognized. Caught by this module's own test.
    const inner = span
      .replace(/`/g, "")
      .trim()
      .replace(/^\$\s*/, "");
    const leader = (inner.split(/\s+/)[0] ?? "").toLowerCase();
    if (VERIFY_COMMAND_LEADERS.includes(leader)) return true;
  }
  return false;
}

/**
 * Whether a corpus referent sits in the same sentence as a Class A trigger.
 *
 * Offsets come from a match against `criterion.elided` and are sliced out of
 * `criterion.raw`. That is sound, not a coincidence: `elideMarkdownNonProse`
 * replaces elided spans with SAME-LENGTH whitespace (its own doc comment states
 * offsets into the original stay valid), and {@link extractCriteria} builds both
 * forms from one `indices` list, so the two strings are aligned character for
 * character. The raw side is what gets tested, because a backticked referent is
 * blanked in the elided form — the same raw/elided split
 * {@link hasInlineVerifyingCommand} relies on.
 *
 * A `.` counts as a sentence boundary only when whitespace or the string end
 * follows it, so `CLAUDE.md` is not split down the middle — which would drop the
 * `md` and defeat the referent pattern that is looking for exactly that filename.
 *
 * A NEWLINE IS NOT A BOUNDARY, and that is the whole subtlety here (PR #3063 R1,
 * BLOCKING). {@link extractCriteria} joins a bullet's continuation lines with `\n`,
 * and this repo wraps prose at 100 characters — so the single most ordinary shape
 * this detector exists for puts the trigger on one line and its referent on the
 * next:
 *
 * ```
 * - [ ] `MINSKY_ACK_UNTAKEN_ACTION` remains functional and remains documented
 *       in `CLAUDE.md` §Hook Files.
 * ```
 *
 * Treating `\n` as a sentence end split exactly that criterion in two and made the
 * referent unreachable from the trigger — a false negative on the AT1 shape itself,
 * silently suppressing the class rather than the noise. Wrapping is a typographic
 * accident of the line width; it carries no sentence structure.
 */
function hasCorpusReferentNear(criterion: ExtractedCriterion, matchIndex: number): boolean {
  const { elided, raw } = criterion;
  const boundary = /[.;!?](?=\s|$)/g;

  let start = 0;
  let end = elided.length;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(elided)) !== null) {
    if (m.index < matchIndex) {
      start = m.index + m[0].length;
    } else {
      end = m.index;
      break;
    }
  }

  const sentence = raw.slice(start, end);
  return CORPUS_REFERENT_PATTERNS.some((p) => p.test(sentence));
}

/** Case-insensitive exact-substring presence — no similarity metric (mem#819). */
function sourceContains(source: AuthorizingSource, needle: string): boolean {
  const haystack = `${source.chosen}\n${source.description}`.toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= CRITERION_EXCERPT_CAP ? flat : `${flat.slice(0, CRITERION_EXCERPT_CAP)}…`;
}

/**
 * Run both classes over a spec's criteria.
 *
 * @param spec - The spec text as written.
 * @param source - The authorizing ask, or `null` when the task has none. Class B is
 *   skipped entirely when `null`.
 * @param elide - Quotation-aware elider; the hook supplies
 *   `elideMarkdownNonProse`. Required rather than defaulted so no caller can
 *   silently skip ADR-024 §Rung 1's elision pass.
 */
export function detectSpecCriterionClaims(
  spec: string,
  source: AuthorizingSource | null,
  elide: (text: string) => string
): SpecCriterionClaimResult {
  const criteria = extractCriteria(spec, elide);
  const findings: CriterionClaimFinding[] = [];

  for (const criterion of criteria) {
    if (!hasInlineVerifyingCommand(criterion.raw)) {
      for (const pattern of CLASS_A_PATTERNS) {
        const m = pattern.exec(criterion.elided);
        // Both conjuncts, or nothing: the trigger vocabulary alone measured a
        // 69.2% fire rate over 120 recent specs. See CORPUS_REFERENT_PATTERNS.
        if (m !== null && hasCorpusReferentNear(criterion, m.index)) {
          findings.push({
            section: criterion.section,
            criterion: excerpt(criterion.elided),
            klass: "A",
            phrase: m[0],
          });
          break;
        }
      }
    }

    if (source === null) continue;

    for (const { pattern, kind } of CLASS_B_PATTERNS) {
      const m = pattern.exec(criterion.elided);
      if (m === null) continue;
      const captured = (m[1] ?? "").trim();
      if (captured === "") continue;

      let absent: boolean;
      let condition: string;
      if (kind === "state") {
        condition = captured;
        absent = !sourceContains(source, captured);
      } else {
        const tokens = captured
          .toLowerCase()
          .split(/[^a-z0-9#-]+/)
          .filter((t) => t.length >= 4 && !OBJECT_STOPWORDS.has(t));
        condition = captured;
        // Fire only when NOTHING in the condition is traceable to the source.
        // A single shared token is enough to make the gate arguably authorized,
        // and silence is the right default for an arguable case.
        absent = tokens.length > 0 && !tokens.some((t) => sourceContains(source, t));
      }

      if (absent) {
        findings.push({
          section: criterion.section,
          criterion: excerpt(criterion.elided),
          klass: "B",
          phrase: m[0].replace(/\s+/g, " ").trim(),
          condition,
          askId: source.askId,
        });
        break;
      }
    }
  }

  return {
    matched: findings.length > 0,
    findings,
    criteriaExamined: criteria.length,
    authorizingSourceAvailable: source !== null,
  };
}
