/**
 * Citation-scope matcher — mt#4830.
 *
 * Answers one question, and it is a MEASUREMENT question rather than a shipping one:
 * **is "a true code citation licensing a false conclusion" mechanically detectable at a useful
 * precision?** mt#4830 SC1 admits "no, and here is the measured rate" as a complete outcome, so
 * this module exists to produce a number, not to be wired into a hook.
 *
 * ## The axis
 *
 * `code-mechanism-assertion` verifies an assertion against its CITED location. The class this
 * module targets passes that check because nothing at the cited location is wrong — the citation
 * is true and the CONCLUSION is false, about a different subject.
 *
 * The worked instance (mt#4804, PR #3517 body):
 *
 * > Registering **is** the backfill: `ingest-service.ts` reads `hwm[source.stream]?.byteOffset`,
 * > `undefined` for a new stream, so it reads from offset 0.
 *
 * `ingest-service.ts` really does read that field; it really is `undefined` for a new stream; it
 * really does read from offset 0. The false part is "registering IS the backfill" — a claim about
 * WHICH RECORDS get ingested, licensed by a citation about byte offsets. `resolveStreamPath`
 * (a sibling module, never opened) resolves those streams elsewhere.
 *
 * ## Why three nested layers rather than one matcher
 *
 * A single matcher yields a single precision number, which answers SC1 only for whatever
 * threshold the author happened to pick. Three strictly-nested layers yield a CURVE, so the
 * measurement says where precision crosses the bar rather than whether one guess cleared it:
 *
 *   L1 ⊃ L2 ⊃ L3
 *
 * - **L1 — citation + connective.** A plausible code symbol and a licensing connective in the
 *   same claim window. Deliberately over-broad; it is the recall ceiling every narrower layer
 *   is measured against, not a candidate mechanism.
 * - **L2 — subject drift.** L1, plus a scope assertion whose subject is NOT one of the cited
 *   symbols. This is the axis stated in the spec.
 * - **L3 — unquantified scope widening.** L2, plus the citation carrying no quantity while the
 *   conclusion asserts totality. This is the tightest reading of the mt#4804 instance.
 *
 * ## Symbol admission is BORROWED, deliberately
 *
 * `symbolsNear` and `elideBlocksAndQuotes` come from the detector rather than being
 * reimplemented here. That is a decision, not convenience: symbol admission is ADR-034's
 * surface, that ADR is REOPENED (mt#4650, measured 73-77% FP), and its disposition is an open
 * principal decision (ask#10657). Keying on the shared function means this measurement inherits
 * whichever disposition ships instead of freezing today's behaviour into a second copy — and it
 * keeps this module honestly silent on an axis it does not decide.
 *
 * ## What this module does NOT claim
 *
 * It does not judge whether a flagged conclusion is actually FALSE. It flags the STRUCTURE — a
 * citation licensing a scope claim about another subject — which is a necessary condition for
 * the failure and nowhere near sufficient. Every measured rate below is a rate for that
 * structure, and the gap between "structure present" and "conclusion wrong" is precisely what
 * SC1 is asking about.
 */

import {
  elideBlocksAndQuotes,
  symbolsNear,
} from "../../.minsky/hooks/code-mechanism-assertion-detector";

/** Which nested layer a match reached. Strictly ordered: L3 implies L2 implies L1. */
export type MatchLayer = "L1" | "L2" | "L3";

export interface CitationScopeMatch {
  /** The claim window the match was found in, trimmed. */
  excerpt: string;
  /** Plausible code symbols in the window, via the detector's own admission. */
  citedSymbols: string[];
  /** The licensing connective(s) that fired. */
  connectives: string[];
  /** Scope/totality assertions found, with the subject each attaches to. */
  scopeAssertions: ScopeAssertion[];
  /** The deepest layer reached. */
  layer: MatchLayer;
}

export interface ScopeAssertion {
  /** The totality marker text, e.g. "is the", "all", "every". */
  marker: string;
  /** The clause subject preceding the marker, trimmed and lowercased. */
  subject: string;
  /** True when `subject` matches none of the window's cited symbols. */
  subjectDrifts: boolean;
}

/**
 * Licensing connectives — the joint the axis is about.
 *
 * `is`/`are` are deliberately NOT here. As a bare copula they are the most common verb in
 * English and would make L1 fire on nearly every sentence; their scope-asserting form
 * (`is the`, `are the`) is picked up as a totality MARKER below instead, which is where it
 * carries information.
 */
const CONNECTIVE_PATTERNS: readonly RegExp[] = [
  /\bso\b/gi,
  /\btherefore\b/gi,
  /\bthus\b/gi,
  /\bhence\b/gi,
  /\bwhich\s+means\b/gi,
  // "meaning" is a licensing connective only in its participial use, which in practice is always
  // preceded by a comma or a dash. Bare `\bmeaning\b` also matches the NOUN — measured live on
  // PR #3524's "The `score` field's MEANING changed", which is not a licensing joint at all.
  /[,—-]\s*meaning\b/gi,
  /\bmeans\s+that\b/gi,
  /\bwhich\s+is\s+why\b/gi,
  /\bconsequently\b/gi,
  /\bit\s+follows\s+that\b/gi,
  /=>/g,
  /→/g,
];

/**
 * Neutralise Markdown emphasis before phrase matching, WITHOUT moving any character.
 *
 * `*` and `_` become spaces rather than being deleted, so every index into the result is still a
 * valid index into the original window — `subjectBefore` slices the original by a marker index
 * found here, and a length-changing normalisation would silently misalign it.
 *
 * This is not cosmetic. The worked instance writes its scope assertion as `Registering **is** the
 * backfill`, and a literal `is the` pattern does not match across the emphasis markers. A matcher
 * that misses the one claim it was built from would have measured a clean 0% FP rate on a corpus
 * it could not see, which is the "unmatchable by construction" failure mem#719 records: a
 * detector emitting output nobody can match erodes trust in the output that IS right. Backticks
 * are deliberately left intact — they are how symbol admission finds a citation.
 */
function normalizeForPhraseMatch(window: string): string {
  // Inline prose-quoted spans are DISCUSSION, not assertion — ADR-024 Rung 1 names them
  // ("prose-quoted spans and explicit discussion-framing") and the shared `elideBlocksAndQuotes`
  // covers only fenced blocks and blockquote LINES, so an inline quotation survives it. Measured
  // live: PR #3528 quotes a guard's own output, *"this guard never fired."*, and the quoted
  // `never` was read as this PR's own scope assertion. Backticked spans are deliberately NOT
  // elided — a backticked symbol is the citation this matcher is keyed on.
  const quotesElided = window.replace(/"[^"\n]*"|“[^”\n]*”/g, (m) => " ".repeat(m.length));
  return quotesElided.replace(/[*_]/g, " ");
}

/**
 * Totality / scope markers. A conclusion carrying one of these asserts something about a SET or
 * an EQUIVALENCE, which is the shape a mechanism citation cannot license on its own.
 *
 * Kept narrow on purpose: `covers`, `handles` and `is the` are the forms the worked instance and
 * its siblings actually used. Widening this list is a precision decision the measurement should
 * inform, not a guess to make up front.
 */
const SCOPE_MARKER_PATTERNS: readonly RegExp[] = [
  /\bis\s+the\b/gi,
  /\bare\s+the\b/gi,
  /\bis\s+equivalent\s+to\b/gi,
  /\ball(?!-)\b/gi,
  /\bevery(?!-)\b/gi,
  /\bnone\s+of\b/gi,
  /\bcovers\b/gi,
  /\bhandles\b/gi,
  /\bentirely\b/gi,
  // The `(?!-)` guards are measured, not defensive: a hyphenated compound uses the word as a
  // MODIFIER, never as a scope assertion. PR #3522's "forwarding an always-defined wrapper" and
  // "an all-projects sweep" are adjectives; flagging them counts English morphology as a claim.
  /\balways(?!-)\b/gi,
  /\bnever(?!-)\b/gi,
  /\bby\s+construction\b/gi,
];

/** A digit run, a spelled small number, or a quantity word — used by L3's citation test. */
const QUANTITY_RE = /\b(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|zero)\b/i;

/**
 * Split prose into claim windows.
 *
 * A window is a sentence, with a colon treated as a clause boundary that STAYS in the window —
 * the worked instance puts its conclusion before the colon and its citation after, so splitting
 * on `:` would separate exactly the two halves whose join is the subject of this measurement.
 *
 * Sentence-final periods are recognised as `.` followed by whitespace and an uppercase letter or
 * a bullet. That deliberately does not split `ingest-service.ts`, `v1.2.3`, or `e.g.` — a period
 * followed by a lowercase letter or a digit is never a boundary here.
 */
export function claimWindows(text: string): string[] {
  const prose = elideBlocksAndQuotes(text);
  const windows: string[] = [];
  for (const paragraph of prose.split(/\n\s*\n/)) {
    // Markdown list items are independent claims even without terminal punctuation.
    for (const item of paragraph.split(/\n(?=\s*(?:[-*+]|\d+\.)\s)/)) {
      for (const sentence of item.split(/(?<=[.!?])\s+(?=[A-Z(`*[])/)) {
        const trimmed = sentence.trim();
        if (trimmed.length > 0) windows.push(trimmed);
      }
    }
  }
  return windows;
}

/** All plausible code symbols in a string, via the detector's own admission rules. */
function symbolsIn(window: string): string[] {
  if (window.length === 0) return [];
  return symbolsNear(window, Math.floor(window.length / 2), window.length);
}

function matchAllText(
  window: string,
  patterns: readonly RegExp[]
): { text: string; index: number }[] {
  const searchable = normalizeForPhraseMatch(window);
  const found: { text: string; index: number }[] = [];
  for (const pattern of patterns) {
    // Patterns are module-level and carry /g, so lastIndex must not leak between windows.
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of searchable.matchAll(re)) {
      found.push({ text: m[0], index: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The clause subject preceding a marker: the run of words between the previous clause boundary
 * and the marker. Lowercased and stripped of backticks so it can be compared against symbols.
 */
function subjectBefore(window: string, markerIndex: number): string {
  const before = window.slice(0, markerIndex);
  const lastBoundary = Math.max(
    before.lastIndexOf(":"),
    before.lastIndexOf(";"),
    before.lastIndexOf(","),
    before.lastIndexOf("—"),
    before.lastIndexOf(". ")
  );
  return before
    .slice(lastBoundary + 1)
    .replace(/[`*_]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * True when `subject` names none of `symbols`.
 *
 * Containment in EITHER direction counts as a match: a subject may be the bare symbol
 * (`resolveStreamPath`), or a noun phrase wrapping it (`the ingest-service.ts read`). Comparison
 * is on lowercased text because the subject has already been lowercased for this purpose.
 */
function driftsFrom(subject: string, symbols: readonly string[]): boolean {
  if (subject.length === 0) return true;
  return !symbols.some((sym) => {
    const s = sym.toLowerCase();
    return subject.includes(s) || s.includes(subject);
  });
}

/**
 * Find citation-scope structures in a block of prose.
 *
 * Returns at most one match per claim window — the deepest layer that window reached — so the
 * per-layer counts a caller tallies are window counts, never inflated by a window carrying
 * several markers.
 */
export function findCitationScopeMatches(text: string): CitationScopeMatch[] {
  const matches: CitationScopeMatch[] = [];

  for (const window of claimWindows(text)) {
    const citedSymbols = symbolsIn(window);
    if (citedSymbols.length === 0) continue;

    const connectives = matchAllText(window, CONNECTIVE_PATTERNS);
    if (connectives.length === 0) continue;

    // L1 reached: a citation and a licensing connective share a claim window.
    const scopeAssertions: ScopeAssertion[] = matchAllText(window, SCOPE_MARKER_PATTERNS).map(
      (m) => {
        const subject = subjectBefore(window, m.index);
        return { marker: m.text, subject, subjectDrifts: driftsFrom(subject, citedSymbols) };
      }
    );

    const drifting = scopeAssertions.filter((a) => a.subjectDrifts);
    let layer: MatchLayer = "L1";
    if (drifting.length > 0) {
      layer = "L2";
      // L3 — the citation quantifies nothing while the conclusion asserts totality. A citation
      // that already carries a number ("reads 27 streams") is not licensing an unquantified
      // widening, whatever else may be wrong with it.
      if (!citationCarriesQuantity(window, citedSymbols)) {
        layer = "L3";
      }
    }

    matches.push({
      excerpt: window,
      citedSymbols,
      connectives: connectives.map((c) => c.text),
      scopeAssertions,
      layer,
    });
  }

  return matches;
}

/**
 * True when a quantity appears within the citation's neighbourhood — the 60 characters after a
 * cited symbol's first mention. A quantity elsewhere in the window (typically inside the
 * conclusion) does not count: the question is whether the CITATION was quantified.
 */
function citationCarriesQuantity(window: string, citedSymbols: readonly string[]): boolean {
  for (const sym of citedSymbols) {
    const at = window.indexOf(sym);
    if (at < 0) continue;
    if (QUANTITY_RE.test(window.slice(at, at + sym.length + 60))) return true;
  }
  return false;
}

/** Tally matches per layer. Nested, so an L3 match also counts toward L2 and L1. */
export function tallyByLayer(matches: readonly CitationScopeMatch[]): Record<MatchLayer, number> {
  const tally: Record<MatchLayer, number> = { L1: 0, L2: 0, L3: 0 };
  for (const m of matches) {
    tally.L1 += 1;
    if (m.layer === "L2" || m.layer === "L3") tally.L2 += 1;
    if (m.layer === "L3") tally.L3 += 1;
  }
  return tally;
}
