/**
 * Bare-prohibition detection for dispatch prompts (mt#3162).
 *
 * A wrong claim in chat is cheap — the next observation contradicts it. A wrong claim written
 * into a dispatch prompt as a PROHIBITION ("do not attempt X") is not: it removes the receiving
 * agent's standing to falsify it. The dispatched agent is the actor with fresh eyes and no sunk
 * reasoning; instructing it not to try is precisely the instruction most likely to suppress the
 * correction. An epistemic error becomes a structural one the moment it crosses a dispatch
 * boundary.
 *
 * The asymmetry this module encodes (memory mem#702, `e437d993`): **a negative conclusion shipped
 * WITH its basis and an explicit licence to falsify it is recoverable; one shipped bare is not.**
 * A bare "do not do X" is unfalsifiable by the recipient. "Do not do X *because* Y — and if Y
 * turns out not to hold, say so" is self-correcting at near-zero cost.
 *
 * Originating incident (2026-07-23, mt#3120): the agent verified one mechanism was unavailable
 * (the MCP caller-identity chain cannot distinguish a parent conversation from its subagents —
 * true), concluded the whole approach was "BLOCKED" (false), and wrote that into two dispatch
 * instructions saying "do not attempt it." A Claude Code PostToolUse hook receives the harness
 * conversation id directly as `input.session_id`, and that exact mechanism had shipped hours
 * earlier in the same repo (mt#3101). What saved it: the prompt ALSO carried the basis and
 * explicit latitude to amend, so the subagent overrode the instruction and cited the precedent.
 *
 * ## Two consumers, one implementation
 *
 * This module is deliberately dependency-free (no imports) so BOTH dispatch paths share exactly
 * one detector rather than drifting copies:
 *
 *  - **`tasks_dispatch`** (in-process) — via the `structuralCheck` option of
 *    {@link validateEvidenceArgument}, closing over the call's `instructions`.
 *  - **The raw `Agent` tool** (harness) — via the `warn-bare-prohibition-dispatch` PreToolUse
 *    hook, reading `tool_input.prompt`. This path is NOT optional: the mt#3120 dispatch never
 *    crossed `tasks_dispatch` (verified against `subagent_invocations` — its only row carries
 *    the Stop-hook `UNKNOWN_AGENT_TYPE` sentinel, meaning no dispatch row was ever written), so
 *    an in-process-only gate would not have caught its own motivating incident.
 *
 * ## Scope of the claim this module makes
 *
 * It detects the SHAPE of a bare prohibition — a prohibition phrase without a nearby basis, or
 * without any licence-to-falsify anywhere in the prompt. It cannot judge whether a stated basis
 * is TRUE or whether a prohibition is warranted; those are not mechanically checkable. The
 * design bet is that requiring the shape is cheap and that the shape is what makes a wrong
 * negative conclusion recoverable.
 *
 * @see mt#3162 — this task
 * @see mem#702 (`e437d993`) — the originating incident + the asymmetry
 * @see mt#2488 — the tier-1 evidence gate this extends
 * @see .minsky/rules/claim-confidence.mdc — the vocabulary a bounded negative claim uses
 */

/**
 * Calibration gate (mt#3162 SC5) — shared by BOTH consumers so the two paths can never disagree
 * about whether this mechanism is blocking.
 *
 * When `false` (v1), a bare prohibition is RECORDED and surfaced as a warning but never blocks a
 * dispatch. The prohibition patterns include deliberately-noisy members (`avoid`, `skip`) whose
 * false-positive rate is unmeasured; blocking on an unmeasured regex would train callers to
 * route around the gate, which is worse than not having it. Flip to `true` only after a
 * `/calibration-review` pass over the fire log shows an acceptable rate — the same
 * calibration -> injection ladder the causal-premise (mt#2216/mt#2263) and
 * constructed-identifier-batch (mt#3125) detectors follow.
 *
 * Graduation is tracked by mt#3167.
 */
export const ENFORCEMENT_ENABLED = false;

/** Maximum characters after a prohibition match scanned for a basis marker. */
export const BASIS_WINDOW_CHARS = 240;

/** Excerpt length recorded per finding (calibration records, error messages). */
export const EXCERPT_CHARS = 200;

/**
 * Prohibition patterns — an instruction telling the recipient NOT to pursue an approach.
 *
 * Deliberately broader than the incident's literal wording so the calibration pass measures a
 * real false-positive rate rather than a rate tuned to one example. `avoid` and `skip` are the
 * known-noisy members (they legitimately appear in scoping prose: "skip the integration tests",
 * "avoid touching unrelated files"); they are included on purpose so calibration can tell us
 * whether to keep them, not dropped on an untested hunch.
 */
export const PROHIBITION_PATTERNS: readonly RegExp[] = [
  /\bdo(?:\s+not|n't)\s+(?:attempt|try|build|implement|pursue|explore|use|add)\b/gi,
  /\bmust\s+not\s+(?:attempt|try|build|implement|pursue|explore|use|add)\b/gi,
  /\bdo(?:\s+not|n't)\s+bother\b/gi,
  /\bavoid\s+(?:attempting|trying|building|implementing|pursuing|exploring|using)\b/gi,
  /\bis\s+(?:currently\s+)?blocked\b/gi,
  /\b(?:is|are)\s+not\s+(?:possible|feasible|available|supported)\b/gi,
  /\b(?:isn't|aren't)\s+(?:possible|feasible|available|supported)\b/gi,
  /\bskip\s+(?:the\s+|this\s+|that\s+)?\w+/gi,
];

/**
 * Basis markers — evidence that the prohibition states WHY, not just WHAT.
 *
 * Scanned in a window BOTH SIDES of the prohibition ({@link BASIS_WINDOW_CHARS} each way). A
 * forward-only window was the first implementation and it was wrong: the dominant real-world
 * shape puts the basis FIRST and the prohibition second — "X is blocked: <reason>, so do not
 * attempt it" (the actual mt#3120 phrasing), "because Y, don't build Z". A forward-only scan
 * flagged the incident's own recoverable prompt as bare, which the test pair caught.
 *
 * Three structural families, none of which requires judging whether the basis is TRUE:
 *
 *  1. **Causal connectives** — including consequence markers ("so do not ..."), which signal
 *     that the reason was just stated.
 *  2. **Explanatory colon** — "X is not possible: <clause>". A semicolon deliberately does NOT
 *     count; it joins two assertions without claiming one explains the other.
 *  3. **Citation markers** — a backticked symbol, a file path, or a task/memory id. mem#702's
 *     account of what made the mt#3120 prompt recoverable is precisely that it "named the MCP
 *     identity chain specifically, not just 'it's blocked'". Naming the thing you checked is
 *     the cheapest honest basis there is.
 */
export const BASIS_PATTERNS: readonly RegExp[] = [
  // (1) causal + consequence connectives
  /\bbecause\b/i,
  /\bsince\b/i,
  /\bdue to\b/i,
  /\bgiven (?:that|the)\b/i,
  /\btherefore\b/i,
  /\bso\s+(?:do|don't|we|you|it|this|that|the)\b/i,
  /\bthe reason\b/i,
  /\brationale\b/i,
  /\breason:/i,
  /\bper\s+\S/i,
  /\b(?:verified|confirmed|checked|observed)\b/i,
  /\bas\s+\S+\s+shows\b/i,
  // (2) explanatory colon (not a semicolon — that joins, it does not explain)
  /(?:blocked|possible|feasible|available|supported|works?)\s*:\s*\S/i,
  // (3) citation markers — naming the specific thing checked
  /`[^`]+`/,
  /\b\w+\/[\w./-]+\.(?:ts|tsx|js|json|md|mdc|sql|ya?ml)\b/i,
  /\b(?:mt|md|gh)#\d+/i,
  /\bmem#\d+/i,
];

/**
 * Licence-to-falsify markers — text granting the recipient standing to override the prohibition
 * and report back. Checked at DOCUMENT level: one grant of latitude covers the whole prompt,
 * which is how the mt#3120 prompt was actually written ("if planning concludes the
 * retitle/rescope is warranted, amend the spec — that is expected").
 */
export const LICENCE_PATTERNS: readonly RegExp[] = [
  /\bif\s+(?:that|this|it|the\s+\w+)\s+(?:turns?\s+out|proves?|does\s*n[o']t|is\s+wrong|is\s+not)\b/i,
  /\bsay\s+so\b/i,
  /\bpush\s+back\b/i,
  /\bamend\s+the\s+spec\b/i,
  /\b(?:override|overrule)\b/i,
  /\bdisagree/i,
  /\breport\s+back\b/i,
  /\b(?:let|tell)\s+me\s+know\s+if\b/i,
  /\bthat\s+is\s+expected\b/i,
  /\bif\s+you\s+find\b/i,
  /\bif\s+(?:the\s+)?basis\b/i,
];

/** One detected prohibition and whether it carried a nearby basis. */
export interface ProhibitionFinding {
  /** The matched prohibition text, verbatim. */
  phrase: string;
  /** Character offset of the match within the analyzed text. */
  index: number;
  /** Text from the match forward, truncated — for calibration records and error messages. */
  excerpt: string;
  /** True when a basis marker appears within {@link BASIS_WINDOW_CHARS} after the match. */
  hasBasis: boolean;
}

/** The full analysis of one dispatch prompt / instructions body. */
export interface NegativeConstraintReport {
  /** Every prohibition matched, basis-annotated. */
  findings: ProhibitionFinding[];
  /** True when any licence-to-falsify marker appears anywhere in the text. */
  hasLicenceToFalsify: boolean;
  /**
   * Prohibitions that are BARE — missing a nearby basis, or present in a prompt that grants no
   * licence to falsify anywhere. Either omission alone makes the prohibition unrecoverable by
   * the recipient, so either alone qualifies.
   */
  bare: ProhibitionFinding[];
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Analyze a dispatch prompt for bare prohibitions.
 *
 * Pure and allocation-light; safe to call on every dispatch. Returns an empty `findings` array
 * for empty/non-string input rather than throwing — a detector must never be the thing that
 * breaks a dispatch.
 */
export function analyzeNegativeConstraints(
  text: string | undefined | null
): NegativeConstraintReport {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { findings: [], hasLicenceToFalsify: false, bare: [] };
  }

  const hasLicenceToFalsify = matchesAny(LICENCE_PATTERNS, text);
  const findings: ProhibitionFinding[] = [];

  for (const pattern of PROHIBITION_PATTERNS) {
    // Each pattern carries the `g` flag; reset `lastIndex` so repeated calls with the same
    // module-level regex objects don't resume mid-string from a prior invocation.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      // Bidirectional window — see BASIS_PATTERNS: a basis stated BEFORE the prohibition is at
      // least as common as one stated after, and is the shape the originating incident used.
      const windowStart = Math.max(0, match.index - BASIS_WINDOW_CHARS);
      const window = text.slice(windowStart, match.index + BASIS_WINDOW_CHARS);
      findings.push({
        phrase: match[0],
        index: match.index,
        excerpt: text.slice(match.index, match.index + EXCERPT_CHARS),
        hasBasis: matchesAny(BASIS_PATTERNS, window),
      });
      match = pattern.exec(text);
    }
  }

  findings.sort((a, b) => a.index - b.index);
  const bare = findings.filter((f) => !f.hasBasis || !hasLicenceToFalsify);

  return { findings, hasLicenceToFalsify, bare };
}

/** Prefix shared by both consumers' messages, so the two paths are greppable as one mechanism. */
export const BARE_PROHIBITION_PREFIX = "Bare prohibition in dispatch prompt (mt#3162):";

/**
 * Build the operator/agent-facing message for a bare-prohibition report. Names what was matched,
 * why it matters, and the accepted form — a rejection the caller cannot act on is a rejection
 * that gets worked around.
 */
export function buildBareProhibitionMessage(report: NegativeConstraintReport): string {
  const listed = report.bare
    .slice(0, 5)
    .map((f) => {
      const missing = !f.hasBasis
        ? report.hasLicenceToFalsify
          ? "no basis stated"
          : "no basis stated, and no licence to falsify anywhere in the prompt"
        : "no licence to falsify anywhere in the prompt";
      return `  - "${f.phrase}" (${missing}) ... ${f.excerpt}`;
    })
    .join("\n");

  return [
    `${BARE_PROHIBITION_PREFIX} this prompt tells the subagent NOT to do something, without`,
    "giving it the standing to find out you were wrong.",
    "",
    listed,
    "",
    "A wrong claim in chat is contradicted by the next observation. A wrong claim encoded as a",
    "dispatch constraint is not — the dispatched agent has fresh eyes and no sunk reasoning, and",
    '"do not attempt X" is the instruction most likely to suppress the correction.',
    "",
    "Required form — state the BASIS, and grant an explicit licence to falsify it:",
    "  do not attempt X BECAUSE <the specific channel/mechanism you actually checked>",
    "  — if <that basis> turns out not to hold, say so and proceed.",
    "",
    'Also bound the claim itself: write "verified unavailable via <channel>", never a bare',
    '"blocked". Checking one channel bounds the finding to that channel (claim-confidence.mdc:',
    "verified-1a for the channel, inferred for the capability).",
  ].join("\n");
}
