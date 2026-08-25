/**
 * Secret-request-in-chat matcher (mt#2428).
 *
 * Fires when the assistant asks the principal to hand over a secret THROUGH THE
 * CONVERSATION — "paste your bot token here", "give me the API key". The chat
 * transcript is persisted to disk AND ingested into the transcripts DB, so a
 * pasted secret becomes durable, searchable, embedded stored data. The correct
 * surface is `credentials.request` (mt#4030), which has no field that can carry
 * a value.
 *
 * ## Why this is a separate detector from `operator-deferral`
 *
 * `operator-deferral-detector` owned two patterns that match these words, and
 * mt#2428 moves them here. The words coincide; the HARMS do not, and their
 * remedies are opposed:
 *
 *   - operator-deferral: "you are handing the principal work you could do
 *     yourself" -> go run the capability probe.
 *   - this detector: "that value must never enter the transcript" -> file a
 *     `credentials.request`.
 *
 * Separate detectors keep the two separately measurable rather than forcing a
 * calibration rater to disambiguate intent per row. Principal decision,
 * ask#9994 (2026-08-25). The phrase-space carve is what keeps one sentence from
 * firing on both and double-counting, which is the discipline
 * `operator-deferral-detector`'s own header imposes on itself against mt#2303.
 *
 * ## The false-positive class this detector is defined by
 *
 * ADR-024 §Context: these hooks "over-fire on quotes/discussion of the trigger
 * phrases themselves, which is exactly the content the detectors' own subject
 * matter generates." For THIS detector that is not an edge case, it is the
 * dominant class — Minsky's corpus discusses asking-for-secrets at length, in
 * rules, specs, memories and handoffs. Measured on the inherited patterns:
 * five fires over sixteen days, ZERO true positives. Every one was either the
 * agent correctly REFUSING, or prose describing the antipattern — including the
 * handoff sentence that announced this very task.
 *
 * So the suppressions are not garnish; they are most of the detector.
 *
 * ## Suppression design is governed by mt#3987 (DONE)
 *
 * That decision, for this detector family:
 *
 *   1. Build NO new shared discussion-framing mechanism — designing one against
 *      anecdotes is the mistake the cluster had already made twice.
 *   2. Use the EXISTING shared helper `elideQuotedAndCodeContexts`. That is the
 *      adapter's job (this module receives already-elided prose), mirroring
 *      `negative-existence-claim.ts`.
 *   3. A detector's NON-quotation false-positive causes are detector-specific
 *      and stay its own. `operator-deferral`'s are named there as negation,
 *      describes-not-defers, override-offer, standing-instruction compliance.
 *   4. `isDetectorMetaDiscussion` is NOT generalized. Its own docblock says:
 *      "The per-detector mechanism question is mt#3987. Do not answer it by
 *      importing this." It is whole-turn suppression tuned to the retrospective
 *      scanner's subject matter, and whole-turn bluntness inverts here.
 *
 * Under (3) this module owns two causes, each tied to a recorded fire:
 *
 *   - NEGATION: "Don't paste the token into this chat" — the agent refusing to
 *     receive a secret, which is the security-correct behaviour. Suppressing it
 *     matters more than usual: acting on the advisory would degrade the very
 *     behaviour it fired on.
 *   - DESCRIBES-RATHER-THAN-REQUESTS: the direct analogue of the sibling's
 *     describes-not-defers. Prose ABOUT a secret request rather than a secret
 *     request. `elideQuotedAndCodeContexts` cannot reach it — the 2026-08-24
 *     record carries no code span, no fence, no blockquote and no double quotes.
 *
 * ## Quote handling differs by surface, deliberately
 *
 * Prose ELIDES quoted spans (the adapter does this) because prose can quote a
 * trigger phrase while merely discussing it. An ask OPTION LABEL cannot: it is
 * the agent's own structured proposal to the principal — it does not quote a
 * request, it IS one. Quote CHARACTERS are stripped from labels so a decorated
 * label still matches, but no span is elided. This mirrors
 * `operator-deferral-detector`'s mt#3273 audit finding verbatim; getting it
 * backwards deletes signal in one direction or the other.
 *
 * @see .minsky/hooks/secret-request-in-chat-detector.ts — the adapter
 * @see mt#3987 — the governing suppression decision
 * @see mt#4030 — `credentials.request`, the surface the advisory names
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";

/** Which surface a match came from — they are logged and tuned separately. */
export type SecretRequestSurface = "assistant-prose" | "ask-option-label";

export interface SecretRequestMatch {
  surface: SecretRequestSurface;
  /**
   * The trigger phrase that hit. This is the calibration sweep's diversity
   * axis, so it must be the PATTERN's span rather than the whole sentence — a
   * sentence is near-unique per fire and would satisfy a distinct-phrase gate
   * by construction, which is the mt#3781 defect.
   */
  matchedPhrase: string;
  /** Surrounding text, for a reader deciding whether the fire was real. */
  context: string;
}

export interface SecretRequestResult {
  matched: boolean;
  matches: SecretRequestMatch[];
  /**
   * Causes that suppressed a candidate this turn. Recorded even when nothing
   * fired: a suppression count is how the FN risk stays visible at calibration
   * review rather than being invisible by construction.
   */
  suppressedBy: SuppressionCause[];
}

export type SuppressionCause =
  | "negation"
  | "describes-rather-than-requests"
  | "routes-to-masked-surface";

/** Longest context excerpt kept per match. */
export const MAX_CONTEXT_CHARS = 240;

/** How far back of a match {@link hasNegationLead} reads. */
const NEGATION_LOOKBACK_CHARS = 40;

/**
 * Secret-class nouns. Deliberately excludes non-secret identifiers the sibling
 * detector's calibration shows are commonly requested and are NOT secrets — a
 * chat id, a username, a URL, a task id. Those are the spec's AT3.
 */
const SECRET_NOUN = "(?:token|credential|key|secret|password|passphrase|pat|api[- ]key)";

/**
 * The request forms.
 *
 * The FIRST entry is moved VERBATIM from `operator-deferral-detector`'s
 * `CAPABILITY_DEFERRAL_PATTERNS[3]` / `ASK_PRINCIPAL_ACTION_PATTERNS[1]`, which
 * is the carve mt#2428 performs — it is the evidenced pattern, with five
 * recorded fires behind it, and moving it verbatim keeps those records
 * replayable against this detector.
 *
 * The other two are the remaining forms mt#2428's accepted `## Detector
 * contract` enumerates. The set is kept tight on purpose: the measured problem
 * on this surface is PRECISION, and ADR-024 §(a) stops the ladder at Rung 1 by
 * default. Widening for recall is explicitly out of scope until a recall miss
 * is on record.
 */
export const SECRET_REQUEST_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(provide|give|paste|share|hand)\\s+(me\\s+)?(the|your|a)\\s+(?:[\\w-]+\\s+){0,3}${SECRET_NOUN}\\b`,
    "i"
  ),
  new RegExp(`\\b(enter|paste|type)\\s+(the|your|a)\\s+(?:[\\w-]+\\s+){0,3}${SECRET_NOUN}\\b`, "i"),
  new RegExp(`\\breply\\s+with\\s+(the|your|a)\\s+(?:[\\w-]+\\s+){0,3}${SECRET_NOUN}\\b`, "i"),
];

/**
 * A PROHIBITION carrying the trigger phrase rather than a request for it.
 *
 * "Don't paste the token into this chat" is the agent REFUSING to receive a
 * secret — required by `terminal-command-best-practices.mdc §Acquiring a
 * credential you do not have`. Firing on it is the worst false positive
 * available here, because acting on the advisory would degrade the
 * security-correct behaviour it fired on.
 *
 * Shape borrowed from `operator-deferral-detector`'s `NEGATION_LEAD_PATTERN`,
 * which is proven on exactly these two recorded sentences. A bare `not` is
 * deliberately omitted for the same reason it is there: "I will not be able to
 * provide the token" is not a refusal to receive one.
 */
const NEGATION_LEAD_PATTERN =
  /\b(?:don'?t|do\s+not|never|no\s+need\s+to|shouldn'?t|should\s+not|isn'?t|is\s+not)\s+(?:\w+\s+){0,3}$/i;

/**
 * Markers that the sentence DESCRIBES a secret request rather than making one.
 *
 * Two shapes, both evidenced:
 *
 *   (a) A third-person subject performing the request — "an agent asking you to
 *       paste a secret". The speech act belongs to someone the sentence is
 *       talking ABOUT, not to the turn.
 *   (b) A describing head noun governing the phrase — detector, pattern, rule,
 *       hook, antipattern — as in "the detector that flags ...".
 *
 * Both are matched only BEFORE the phrase and only within the SAME SENTENCE, so
 * a describing clause elsewhere in a long turn cannot silence a real request.
 */
const DESCRIBING_FRAME_PATTERNS: readonly RegExp[] = [
  // (a) third-person attribution of the request
  /\b(an?|the|any|some|another)\s+(agent|assistant|bot|model|llm)\b[^.!?]{0,60}\b(ask|asks|asking|request|requests|requesting|tell|tells|telling|prompt|prompts|prompting)\b/i,
  /\basking\s+(you|the\s+(?:user|principal|operator))\s+to\b/i,
  // (b) a describing head noun
  /\b(detector|detectors|pattern|patterns|rule|rules|hook|hooks|guard|guards|check|checks|anti-?pattern)\b/i,
  /\b(flags?|fires?\s+on|matches|catches|warns?\s+(?:on|about)|triggers?\s+on)\b/i,
];

/**
 * Markers that the turn is routing the principal to a MASKED surface rather
 * than asking for the value in chat. This is the spec's AT2 and the whole point
 * of the advisory — an agent that already did the right thing must not be told
 * to do it.
 */
const MASKED_SURFACE_PATTERNS: readonly RegExp[] = [
  /\bcredentials?[._]request\b/i,
  /\bcredentials?\s+widget\b/i,
  /\bmasked\s+(form|surface|field|input|env)\b/i,
  /\bcockpit\b[^.!?]{0,40}\bcredential/i,
];

/** Split into sentences, keeping each one's offset in the original text. */
function sentencesWithOffsets(text: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const re = /[^.!?\n]+[.!?]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push({ text: m[0], offset: m.index });
  }
  return out;
}

/** True when a negation attaches to the verb within the lookback window. */
export function hasNegationLead(sentence: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - NEGATION_LOOKBACK_CHARS);
  return NEGATION_LEAD_PATTERN.test(sentence.slice(start, matchIndex));
}

/** True when the text BEFORE the match frames it as description, not request. */
export function hasDescribingFrame(sentence: string, matchIndex: number): boolean {
  const lead = sentence.slice(0, matchIndex);
  return DESCRIBING_FRAME_PATTERNS.some((re) => re.test(lead));
}

/** True when the text routes to a masked surface. */
export function routesToMaskedSurface(text: string): boolean {
  return MASKED_SURFACE_PATTERNS.some((re) => re.test(text));
}

/**
 * Strip quote characters without removing the words between them.
 *
 * For ask option labels only. `Provide me the "MCP auth token"` must still
 * match: the filler group is `[\w-]+`, and `"MCP` opens with a non-word
 * character, so leaving the quote in place is a silent false NEGATIVE. The
 * sibling detector found this in its own mt#3273 audit.
 */
export function stripQuoteChars(text: string): string {
  return text.replace(/["'“”‘’]/g, "");
}

/**
 * A window around the match, surrogate-safe.
 *
 * `safeTruncate` rather than a bare slice because this string is written into a
 * calibration JSONL that is later re-parsed: a naive cut can sever a surrogate
 * pair, and `JSON.stringify` will happily emit the unpaired half that the
 * re-parser then rejects (mt#1598). A secret-request sentence is ordinary prose
 * and can carry an emoji like any other.
 *
 * The leading cut is taken with `tail` so a severed pair is dropped from the
 * START of the window, then the length cap with `head` for the END.
 */
function contextAround(sentence: string, index: number, length: number): string {
  const pad = Math.max(0, Math.floor((MAX_CONTEXT_CHARS - length) / 2));
  const start = Math.max(0, index - pad);
  const fromStart = safeTruncate(sentence, sentence.length - start, "tail");
  return safeTruncate(fromStart, MAX_CONTEXT_CHARS, "head").trim();
}

/**
 * Scan assistant PROSE. Expects text the caller has already passed through
 * `elideQuotedAndCodeContexts` — see the module docblock for why elision is the
 * adapter's job and why it applies to prose but never to option labels.
 */
export function detectSecretRequestInProse(prose: string): SecretRequestResult {
  const matches: SecretRequestMatch[] = [];
  const suppressedBy: SuppressionCause[] = [];

  if (!prose.trim()) return { matched: false, matches, suppressedBy };

  // Whole-text check: routing to the masked surface is a property of the turn,
  // not of one sentence — the agent may name the surface in an adjacent
  // sentence to the one carrying the phrase.
  const routed = routesToMaskedSurface(prose);

  for (const sentence of sentencesWithOffsets(prose)) {
    for (const pattern of SECRET_REQUEST_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence.text)) !== null) {
        const idx = m.index;
        if (hasNegationLead(sentence.text, idx)) {
          suppressedBy.push("negation");
          continue;
        }
        if (hasDescribingFrame(sentence.text, idx)) {
          suppressedBy.push("describes-rather-than-requests");
          continue;
        }
        if (routed) {
          suppressedBy.push("routes-to-masked-surface");
          continue;
        }
        matches.push({
          surface: "assistant-prose",
          matchedPhrase: m[0].trim(),
          context: contextAround(sentence.text, idx, m[0].length),
        });
      }
    }
  }

  return { matched: matches.length > 0, matches, suppressedBy };
}

/**
 * Scan `AskUserQuestion` option labels.
 *
 * No elision and no describing-frame check: an option label is the agent's own
 * proposal to the principal, so it cannot be describing someone else's request.
 * Negation and masked-surface routing still apply — an option reading "Use the
 * masked credentials form" is the right answer, not a fire.
 */
export function detectSecretRequestInOptionLabels(labels: readonly string[]): SecretRequestResult {
  const matches: SecretRequestMatch[] = [];
  const suppressedBy: SuppressionCause[] = [];

  for (const label of labels) {
    if (!label.trim()) continue;
    if (routesToMaskedSurface(label)) {
      suppressedBy.push("routes-to-masked-surface");
      continue;
    }
    const matchable = stripQuoteChars(label);
    for (const pattern of SECRET_REQUEST_PATTERNS) {
      const m = pattern.exec(matchable);
      if (!m) continue;
      if (hasNegationLead(matchable, m.index ?? 0)) {
        suppressedBy.push("negation");
        continue;
      }
      matches.push({
        surface: "ask-option-label",
        matchedPhrase: m[0].trim(),
        // Report the ORIGINAL label, not the quote-stripped rewrite — the
        // calibration record should show what the agent actually wrote.
        context: safeTruncate(label, MAX_CONTEXT_CHARS, "head").trim(),
      });
      break;
    }
  }

  return { matched: matches.length > 0, matches, suppressedBy };
}
