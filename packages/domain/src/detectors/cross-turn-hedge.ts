/**
 * Cross-turn hedge-decay matcher — mt#4701.
 *
 * `claim-confidence.mdc` ships a two-axis claim vocabulary and RFC `3a0937f0`
 * (Accepted 2026-07-18) reserved a companion detector as its Phase 3 candidate —
 * "a cheap high-precision companion detector … gives the vocabulary a falsifier
 * instead of relying on self-assessment alone". That candidate was never filed, so
 * the vocabulary has shipped with nothing matching on it: grepping the hook tree for
 * `verified-1a` / `strong-evidence` / `inferred` returns only guidance text the
 * detectors EMIT, never a corpus any of them READS.
 *
 * This is that falsifier, one axis over. The RFC's own axis is *labeled verified,
 * unbacked*; this one is **labeled uncertain, then asserted unbacked** — an agent
 * marks a claim as an inference in one turn and restates it as fact in a later turn
 * with nothing having resolved it in between.
 *
 * ## Why a WINDOW, and why this is not a new evaluation scope
 *
 * The originating spec framed this as "every detector scopes to one completed turn,
 * so the pair is structurally invisible". That framing is false and was corrected at
 * planning: `pre-narration-detector.ts` has evaluated a 12-turn window since mt#2671
 * and correlates a claim's named PR against in-window evidence
 * (`buildIdentityEvidence`, mt#3864). This module reuses that shape — the window is
 * established machinery, and what was missing is a PREDICATE keyed on the agent's own
 * epistemic label.
 *
 * The direction is inverted from `pre-narration`'s: there the window SUPPRESSES (a
 * claim backed by an in-window tool call is a legitimate back-reference); here it
 * FINDS (an in-window hedge on the same subject that nothing since has resolved).
 *
 * ## The suppressor deliberately EXCLUDES the hedge turn
 *
 * {@link detectCrossTurnHedgeDecay} treats a subject as resolved only when a tool
 * call names it in a turn STRICTLY AFTER the hedge — window `(hedgeTurn,
 * assertionTurn]`. This is not a detail; including the hedge turn makes the detector
 * inert on the incident that produced it.
 *
 * Measured against that transcript (`c2027e82`, 2026-08-27): the hedge sits in turn
 * 3, whose own `memory_get {id: "mem#1323"}` returned `sourceAgentId: null` — the
 * call that CREATED the uncertainty. Counting it as verification would suppress the
 * fire. Turns 4 and 5 carry zero tool calls naming the subject, so the turn-5
 * restatement fires; turn 6's correction runs the discriminating grep in its own
 * turn, so it is suppressed. A probe that returns the same answer whether or not the
 * claim was resolved is not verification (mem#704) — and here the same probe is
 * evidence FOR the hedge.
 *
 * ## Why this lives in the domain package
 *
 * ADR-024's Decision clause requires the guidance-hook ladder be "built on the shared
 * `packages/domain/src/detectors/` framework so all guidance hooks consume one
 * mechanism instead of divergent regex copies". The matcher lives here and
 * `.minsky/hooks/cross-turn-hedge-detector.ts` is a thin adapter — the split
 * {@link ./spec-criterion-claim.ts} and {@link ./negative-existence-claim.ts} already
 * made.
 *
 * The elider is INJECTED for the same layering reason those modules give: ADR-024
 * §Rung 1 prescribes quotation-aware elision before matching and the canonical
 * implementation is `elideMarkdownNonProse` in `.minsky/hooks/`, which a domain
 * module must not import. The adapter supplies that exact function.
 *
 * ## Rung placement
 *
 * Rung 1. Both conjuncts are deterministic: a fixed marker vocabulary and a
 * closed-form subject key. Do NOT answer a paraphrase miss by widening
 * {@link NATURAL_LANGUAGE_HEDGES} — that is the arms race ADR-024's `## Context`
 * exists to end, and the subject-key restriction below is what buys the precision
 * that makes Rung 1 viable here.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see .minsky/hooks/cross-turn-hedge-detector.ts — the adapter
 * @see .minsky/hooks/pre-narration-detector.ts — the window precedent this mirrors
 */

/**
 * Subject keys, restricted to a decidable closed form.
 *
 * Free-noun-phrase matching is explicitly out of scope: it is what makes this claim
 * class look intractable, and the repo's claims routinely name entities outright.
 * Each pattern carries its `kind` so calibration can measure — and retire — one class
 * without touching the others.
 *
 * `filePath` is the loosest member and is expected to be the noisiest: an agent
 * hedging about a file and later naming it is ordinary, where an entity ref is far
 * more often the SUBJECT of a claim. It is admitted because the spec's criterion
 * names it and it is genuinely decidable; its fire rate is recorded separately so a
 * calibration review can drop it on evidence rather than on argument.
 */
export const SUBJECT_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "task", pattern: /\bmt#\d+\b/gi },
  { kind: "memory", pattern: /\bmem#\d+\b/gi },
  { kind: "ask", pattern: /\bask#\d+\b/gi },
  { kind: "workspace", pattern: /\bws#\d+\b/gi },
  { kind: "changeset", pattern: /\bPR\s*#\d+\b/gi },
  {
    kind: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  // The leading `\.?` is load-bearing in THIS repo: `.minsky/hooks/…`,
  // `.claude/hooks/…` and `.github/workflows/…` are among the most-cited paths in
  // agent prose, and a `\b`-anchored pattern silently drops their leading dot —
  // recording `minsky/hooks/x.ts`, a key that no longer denotes the file it came
  // from. The lookbehind is what keeps the optional dot from starting a match in the
  // middle of an already-matched path, and it also declines `minsky://task/…`, whose
  // scheme colon breaks the segment run.
  {
    kind: "filePath",
    pattern: /(?<![\w/.-])\.?[\w-][\w.-]*(?:\/[\w.-]+)+\.[a-z]{2,5}\b/g,
  },
];

/**
 * The closed warrant vocabulary from `claim-confidence.mdc`, which RFC `3a0937f0`
 * ratified via ask `755ddc6a`. This is the leg the RFC actually asked for: a label
 * the agent applied to its own claim, from a set the principal approved.
 *
 * `unknown` is present but **shape-constrained**, and the constraint is the whole
 * reason it can be here at all (PR #3419 R1). It is a legitimate warrant label AND an
 * ordinary English word — "the author is unknown" describes the world; `(unknown: no
 * probe run)` labels a claim. Matching it bare would import a precision problem the
 * other three do not have; omitting it would drop a label the vocabulary actually
 * defines.
 *
 * So it matches only in LABEL POSITION, which is how `claim-confidence.mdc` writes
 * warrants in the first place: its format is `[delivery state] — [warrant + basis]`,
 * so a real warrant label is parenthesized, dash-led, or follows a `warrant:` /
 * `confidence:` / `basis:` key. That is a shape test, not a phrase list — it does not
 * widen with paraphrase, so it stays inside ADR-024's Rung 1 rather than starting the
 * arms race its `## Context` exists to end.
 *
 * The set is CLOSED and is exactly the four labels `claim-confidence.mdc` defines for
 * this axis — nothing else belongs here, however hedge-like it reads. `unverified`
 * was in this list until PR #3419 R2 and is not one of them; it now sits in
 * {@link NATURAL_LANGUAGE_HEDGES}, where it is still matched but measured
 * separately. That distinction is the whole point of the two-leg split: the
 * vocabulary leg's fire rate has to mean "the ratified labels are decaying", and one
 * smuggled-in synonym makes it mean something vaguer instead.
 */
export const WARRANT_VOCABULARY: readonly RegExp[] = [
  /\bstrong[-\s]evidence\b/i,
  /\binferred\b/i,
  /\bassumed\b/i,
  /(?:\(|\[|—\s*|--?\s+|\b(?:warrant|confidence|basis|status)\s*[:=]\s*)unknown\b|\bunknown\s*:/i,
];

/**
 * Natural-language hedges — the second, separately-measured leg.
 *
 * Kept deliberately small and first-person-anchored. A hedge is a thing the agent
 * says about ITS OWN claim, so "may be wrong" earns its place while a bare "unclear"
 * does not: the latter describes the world, not the agent's warrant for a statement
 * about it.
 */
export const NATURAL_LANGUAGE_HEDGES: readonly RegExp[] = [
  /\b(?:may|might|could)\s+be\s+wrong\b/i,
  /\bnot\s+(?:yet\s+)?verified\b/i,
  // Moved here from WARRANT_VOCABULARY in PR #3419 R2 — a real hedge, but not one of
  // the four ratified labels, so it is measured on this leg instead of inflating the
  // vocabulary leg's rate.
  /\bunverified\b/i,
  /\bunconfirmed\b/i,
  /\bI\s+(?:inferred|am\s+inferring|'m\s+inferring)\b/i,
  /\bI\s+(?:am\s+assuming|'m\s+assuming)\b/i,
  /\b(?:I\s+)?overreached\b/i,
  /\bnot\s+certain\b/i,
  /\bthat\s+inference\b/i,
];

/** Which marker family fired — recorded so the two legs tune independently. */
export type HedgeLeg = "warrant-vocabulary" | "natural-language";

/** One turn's assistant prose, as scanned. `index` is the turn's window position. */
export interface ScannedTurn {
  /** Window position; larger is more recent. Only ordering is significant. */
  index: number;
  prose: string;
}

export interface CrossTurnHedgeInput {
  /** Turns preceding the one under evaluation, oldest first. */
  priorTurns: readonly ScannedTurn[];
  /** The just-completed turn, whose assertions are the subject of the check. */
  currentTurn: ScannedTurn;
  /**
   * Subject keys named by any tool call — input or result — in each turn.
   * A key present here for a turn after the hedge marks the subject RESOLVED.
   */
  toolSubjectsByTurn: ReadonlyMap<number, ReadonlySet<string>>;
  /** ADR-024 Rung-1 quotation elision. Supplied by the adapter; see the header. */
  elide: (text: string) => string;
}

export interface HedgeDecayFinding {
  subject: string;
  subjectKind: string;
  hedgeTurnIndex: number;
  hedgeLeg: HedgeLeg;
  hedgeMarker: string;
  hedgeExcerpt: string;
  assertionExcerpt: string;
}

export interface CrossTurnHedgeResult {
  matched: boolean;
  findings: HedgeDecayFinding[];
  /** Every subject hedged in the window, whether or not it was later asserted. */
  hedgedSubjects: readonly string[];
  /** Hedged subjects a post-hedge tool call named — the suppressed set. */
  resolvedSubjects: readonly string[];
}

/** Max characters of surrounding prose carried into a finding. */
export const MAX_EXCERPT_CHARS = 240;

/**
 * Split prose into candidate claim units.
 *
 * Newlines split as well as sentence terminators: agent prose is markdown, where a
 * bullet or heading is a claim unit that frequently carries no terminating period.
 * Splitting on terminators alone would join a heading to the paragraph beneath it and
 * let an unrelated hedge three lines away suppress — or manufacture — a match.
 */
export function splitClaimUnits(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize a subject key so `PR #12`, `PR#12` and `pr #12` are one subject. */
export function normalizeSubject(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "");
}

/** Every subject key in `text`, normalized, with the pattern kind that found it. */
export function extractSubjects(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const { kind, pattern } of SUBJECT_PATTERNS) {
    // A fresh RegExp per call: the module-level literals carry /g, and a shared
    // lastIndex across calls would silently skip matches on every other input.
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = normalizeSubject(m[0]);
      if (!found.has(key)) found.set(key, kind);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return found;
}

/** The first hedge marker in `unit`, or null. Warrant vocabulary takes precedence. */
export function findHedgeMarker(unit: string): { leg: HedgeLeg; marker: string } | null {
  for (const pattern of WARRANT_VOCABULARY) {
    const m = pattern.exec(unit);
    if (m) return { leg: "warrant-vocabulary", marker: m[0] };
  }
  for (const pattern of NATURAL_LANGUAGE_HEDGES) {
    const m = pattern.exec(unit);
    if (m) return { leg: "natural-language", marker: m[0] };
  }
  return null;
}

function excerpt(unit: string): string {
  return unit.length <= MAX_EXCERPT_CHARS ? unit : `${unit.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/**
 * Find claims hedged in a prior turn and restated as fact in the current one.
 *
 * Fires when ALL of:
 *   1. A prior turn's prose carries a hedge marker and a subject key in the SAME
 *      claim unit.
 *   2. The current turn asserts that same subject in a unit carrying NO hedge marker.
 *   3. No tool call named that subject in any turn strictly after the hedge, through
 *      the current turn — see the header on why the hedge turn is excluded.
 *
 * A question is not an assertion, so units ending in `?` are skipped: "is mem#1323
 * still the right handoff?" restates nothing.
 */
export function detectCrossTurnHedgeDecay(input: CrossTurnHedgeInput): CrossTurnHedgeResult {
  const { priorTurns, currentTurn, toolSubjectsByTurn, elide } = input;

  // Earliest hedge wins: the further back the label, the more decay has occurred,
  // and reporting the first one makes the finding's two turns maximally informative.
  const hedges = new Map<
    string,
    { kind: string; turnIndex: number; leg: HedgeLeg; marker: string; excerpt: string }
  >();

  for (const turn of [...priorTurns].sort((a, b) => a.index - b.index)) {
    for (const unit of splitClaimUnits(elide(turn.prose))) {
      const marker = findHedgeMarker(unit);
      if (!marker) continue;
      for (const [subject, kind] of extractSubjects(unit)) {
        if (hedges.has(subject)) continue;
        hedges.set(subject, {
          kind,
          turnIndex: turn.index,
          leg: marker.leg,
          marker: marker.marker,
          excerpt: excerpt(unit),
        });
      }
    }
  }

  const resolved = new Set<string>();
  for (const [subject, hedge] of hedges) {
    for (const [turnIndex, keys] of toolSubjectsByTurn) {
      if (turnIndex <= hedge.turnIndex) continue;
      if (turnIndex > currentTurn.index) continue;
      if (keys.has(subject)) {
        resolved.add(subject);
        break;
      }
    }
  }

  const findings: HedgeDecayFinding[] = [];
  const seen = new Set<string>();
  for (const unit of splitClaimUnits(elide(currentTurn.prose))) {
    if (unit.endsWith("?")) continue;
    if (findHedgeMarker(unit)) continue;
    for (const subject of extractSubjects(unit).keys()) {
      const hedge = hedges.get(subject);
      if (!hedge || resolved.has(subject) || seen.has(subject)) continue;
      seen.add(subject);
      findings.push({
        subject,
        subjectKind: hedge.kind,
        hedgeTurnIndex: hedge.turnIndex,
        hedgeLeg: hedge.leg,
        hedgeMarker: hedge.marker,
        hedgeExcerpt: hedge.excerpt,
        assertionExcerpt: excerpt(unit),
      });
    }
  }

  return {
    matched: findings.length > 0,
    findings,
    hedgedSubjects: [...hedges.keys()],
    resolvedSubjects: [...resolved],
  };
}
