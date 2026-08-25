/**
 * Does the principal's message complain about how MUCH the agent wrote? (mt#4540)
 *
 * **This is a CANDIDATE finder, not a classifier, and the distinction is the
 * whole design.** It answers "is this worth a human reading" — never "this is a
 * complaint." The population it screens is small enough to hand-classify
 * entirely, so a screen that over-matches costs one line of triage while a
 * screen that under-matches loses the signal; it is deliberately loose, and
 * every consumer is expected to read the matched text.
 *
 * That is not caution for its own sake. The first cut of this screen, run
 * ad hoc during mt#4540's planning, reported 6 hits over the depth-suppressed
 * population; reading them showed 3 were genuine and 3 were topic redirects
 * ("Okay, hold on. What just happened? We were talking about…") whose later
 * sentences happened to contain "too much" about something other than length.
 * Reporting 6 as a rate would have overstated the effect by 2x. So the return
 * carries the matched span and its surrounding context, because the only way to
 * use this correctly is to look.
 *
 * @see mt#4540 — the measurement this serves
 * @see scripts/replay-wall-of-text-window.ts — its consumer
 */

/**
 * Phrases that make a message WORTH READING as a possible length complaint.
 *
 * Named rather than anonymous so a candidate can report which one fired — the
 * same convention `wall-of-text-detector.ts`'s `SKILL_LABEL_PATTERNS` uses, and
 * for the same reason: a reviewer classifying a hit needs to know what the
 * screen saw, not just that it saw something.
 */
export const LENGTH_COMPLAINT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "too-much", re: /too (long|much|verbose|wordy)/i },
  { name: "way-too", re: /way too/i },
  { name: "be-concise", re: /(more|be) concise/i },
  { name: "too-many-words", re: /too many words/i },
  { name: "cannot-process", re: /can(not|'?t) process/i },
  { name: "wall-of-text", re: /wall of text/i },
  { name: "tldr", re: /\btl;?dr\b/i },
  { name: "summarize-shorter", re: /summar(y|ize|ise)[^.!?]{0,30}(concise|short|brief)/i },
  { name: "less-detail", re: /less detail/i },
  { name: "shorter", re: /\bshorter\b/i },
];

/** How much text either side of the match to carry, so a reader can judge it. */
export const CONTEXT_CHARS = 90;

export interface LengthComplaintCandidate {
  /** Whether ANY pattern matched. Not a verdict — see the module doc. */
  isCandidate: boolean;
  /** Names of every pattern that matched, in declaration order. */
  patterns: string[];
  /**
   * The matched span plus {@link CONTEXT_CHARS} either side, whitespace
   * collapsed. Empty when nothing matched. This is what a human reads to
   * decide, and its presence is why the return type is not a boolean.
   */
  context: string;
}

/**
 * Screen `text` for language that might be complaining about output length.
 *
 * Returns candidates for a human to classify. Callers MUST NOT treat
 * `isCandidate` as a verdict; report it as "N candidates, hand-classified to M"
 * rather than as a rate on its own.
 */
export function detectLengthComplaint(text: string): LengthComplaintCandidate {
  const normalized = text.replace(/\s+/g, " ");
  const patterns: string[] = [];
  let firstIndex = -1;
  let firstLength = 0;

  for (const { name, re } of LENGTH_COMPLAINT_PATTERNS) {
    const match = re.exec(normalized);
    if (match === null) continue;
    patterns.push(name);
    if (firstIndex < 0 || match.index < firstIndex) {
      firstIndex = match.index;
      firstLength = match[0].length;
    }
  }

  if (patterns.length === 0) return { isCandidate: false, patterns: [], context: "" };

  const start = Math.max(0, firstIndex - CONTEXT_CHARS);
  const end = Math.min(normalized.length, firstIndex + firstLength + CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";

  return {
    isCandidate: true,
    patterns,
    context: `${prefix}${normalized.slice(start, end)}${suffix}`,
  };
}
