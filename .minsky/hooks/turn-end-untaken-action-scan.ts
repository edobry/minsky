#!/usr/bin/env bun
// Stop-event guard: catch a turn that ENDS by naming an immediately-executable
// next action without executing it (mt#3179).
//
// Why the FINAL message is the whole signal: at Stop time the turn is over, so
// anything appearing in `last_assistant_message` had NO tool call after it by
// construction. Position IS the discriminator — no heuristic needed to decide
// whether the announced action was taken. Announce-then-do is invisible here
// (the announcement sits mid-turn, followed by calls); announce-then-stop puts
// the announcement in the final message. That asymmetry is the guard.
//
// Why this is NOT covered by ask-routing-deferral-detector: that detector's
// corpus is DEFERRAL-shaped ("say the word", "let me know"). The mt#3179 R3
// incident ended with COMMITMENT-shaped text — "I'm taking it forward … that's
// the next step, not a question" — which reads as the opposite of a deferral
// and actively suppresses suspicion by asserting the action is happening. A
// sentiment-keyed corpus cannot catch it; a position-keyed check can.
//
// Key on the SURFACE, not the reason (mt#3179 §R3): R2 stopped by asking
// permission, R3 stopped by announcing intent, one turn after R2's
// retrospective. Reasons are unbounded; the observable surface — turn ends,
// action named, no call made — is one thing.
//
// Advisory-only, never `deny`: the Stop-hook continuation gives the agent one
// beat to actually perform the action, which is the entire remedy. Dedup bounds
// a false positive to exactly one extra beat.
//
// @see .minsky/hooks/turn-end-retro-scan.ts — sibling Stop guard; same shape
// @see .minsky/hooks/dispatch-stop.ts — the Stop dispatcher entrypoint
// @see mt#3179 — originating task; mem#394 — the family record (R1/R2/R3)

import type { DispatchContext, GuardOutcome } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";
import {
  STOP_INJECTED_OVERLAP_FAMILY,
  flagKey,
  overlapTurnKey,
  readFlagged,
  writeFlagged,
} from "./turn-end-scan-store";
import { createHash } from "node:crypto";
import { cappedEvidenceLines } from "./guard-feedback-format";
import { elideQuotedAndCodeContexts } from "./elision";
import { detectDeferralPhrases } from "./ask-routing-deferral-detector";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_UNTAKEN_ACTION";

/**
 * RETIRED as an active suppression reason (mt#3620). This guard no longer
 * yields to the prompt-time ask-routing-deferral detector — see the inversion
 * rationale at the overlap block in {@link run}.
 *
 * The string is kept exported because it appears in ~18 pre-mt#3620 calibration
 * records that the review cadence still reads; deleting it would make those
 * records unclassifiable. No code path emits it any more.
 */
export const SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL = "deduped-by-ask-routing-deferral";

/**
 * How much of the final message's tail to scan. The failure shape is a
 * sign-off — the announcement is the last thing said, not something buried
 * mid-message. A tail window keeps a mid-message "I'll do X" (which the turn
 * then went on to DO) from matching.
 */
export const TAIL_WINDOW_CHARS = 600;

/**
 * Commitment-shaped announcements of an immediately-executable next action.
 * Derived from real incidents (mt#3179 R2/R3), not invented:
 *   R2: "say the word and I'll merge"        (deferral-shaped stop)
 *   R3: "I'm taking it forward … that's the next step, not a question"
 */
const COMMITMENT_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = [
  {
    family: "taking-forward",
    re: /\bi'?m\s+(?:taking|carrying)\s+(?:it|this|that|mt#\d+)\s+forward\b/i,
  },
  { family: "next-step", re: /\bthat'?s\s+the\s+next\s+step\b/i },
  { family: "next-up", re: /\bnext\s+(?:up|step)\s*(?:is|:|—|-)/i },
  { family: "proceed-to", re: /\bi'?ll\s+(?:proceed|move|go)\s+(?:to|on\s+to|ahead\s+with)\b/i },
  {
    family: "ill-start",
    re: /\bi'?ll\s+(?:start|begin|kick\s+off|pick\s+up|take)\s+(?:on\s+)?(?:it|that|this|mt#\d+)\b/i,
  },
  {
    family: "ill-action",
    re: /\bi'?ll\s+(?:merge|implement|plan|file|fix|ship|land)\s+(?:it|that|this|mt#\d+)\b/i,
  },
  { family: "moving-on", re: /\bmoving\s+on\s+to\b/i },
  { family: "say-the-word", re: /\bsay\s+the\s+word\b/i },
  { family: "give-go-ahead", re: /\b(?:give|say)\s+(?:me\s+)?the\s+go-?ahead\b/i },
];

/**
 * Signals that the turn ended for a LEGITIMATE reason — the agent did take an
 * action and is genuinely waiting on it, or the principal deferred the work.
 * Narrow by design: over-suppressing re-opens the exact gap this guard closes.
 *
 * Verified against real fixtures: the mt#3155 turn that armed a retry watcher
 * ("A retry watcher is armed … I'll re-attempt when it fires") must NOT fire;
 * the R2 and R3 failing turns carried none of these markers.
 */
const SUPPRESSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwatcher\s+is\s+armed\b/i,
  /\barmed\s+(?:a\s+)?(?:background\s+)?(?:watcher|poll|retry|wakeup)\b/i,
  /\brunning\s+in\s+the\s+background\b/i,
  /\bi'?ll\s+report\s+(?:back\s+)?when\b/i,
  /\bwaiting\s+(?:for|on)\s+/i,
  /\bno\s+action\s+needed\s+from\s+you\b/i,
  /\byou\s+asked\s+me\s+(?:to\s+stop|not\s+to)\b/i,
];

export interface UntakenActionMatch {
  family: string;
  matchedPhrase: string;
}

/**
 * Pure detector — exported for tests. Returns matches found in the TAIL of the
 * final assistant message, unless a suppression signal is present anywhere in
 * that message.
 *
 * Matching runs over quoted-context-ELIDED text (mt#3336): code fences,
 * inline code, blockquotes, and double-quoted prose are blanked first, so a
 * commitment phrase the agent is QUOTING — detector data in a handoff's
 * blockquote (the mt#3303 self-demonstrating false positive), a rule excerpt,
 * a calibration record — cannot fire. Same posture, same rationale, as the
 * ask-routing-deferral sibling's mt#3271 fix; elision blanks with same-length
 * whitespace so tail-window offsets are unaffected.
 */
export function detectUntakenAction(finalMessage: string): UntakenActionMatch[] {
  if (!finalMessage) return [];

  const scanned = elideQuotedAndCodeContexts(finalMessage);

  for (const s of SUPPRESSION_PATTERNS) {
    if (s.test(scanned)) return [];
  }

  const tail =
    scanned.length > TAIL_WINDOW_CHARS
      ? scanned.slice(scanned.length - TAIL_WINDOW_CHARS)
      : scanned;

  const matches: UntakenActionMatch[] = [];
  for (const { family, re } of COMMITMENT_PATTERNS) {
    const m = re.exec(tail);
    if (m) matches.push({ family, matchedPhrase: m[0] });
  }
  return matches;
}

function buildReminder(matches: UntakenActionMatch[]): string {
  const lines: string[] = [
    "[turn-end-untaken-action] You named a next action and ended the turn without taking it.",
    "",
  ];
  lines.push(...cappedEvidenceLines(matches, (m) => `  - ${m.family}: "${m.matchedPhrase}"`));
  lines.push(
    "",
    "Take it now in this continuation, then report the result. If it genuinely cannot " +
      "proceed — you are blocked on a principal decision, a red check, or an external " +
      "condition you have already armed a watcher for — name which in one line and end."
  );
  return lines.join("\n");
}

/**
 * Dedup key for one turn, derived from the FINAL MESSAGE rather than from the
 * transcript's opening prompt (PR #2293 R1).
 *
 * The sibling retro-scan guard keys on the transcript's opening-prompt uuid via
 * `turnKeyFor`, which returns the literal `"session-start"` when no transcript
 * is available. For THIS guard that default is actively harmful: every turn in
 * the session would share one key, so the first fire of a given (family,
 * phrase) would suppress that phrase for the REST OF THE SESSION — silencing
 * exactly the repeat offenses the guard exists to catch. (`needsTranscript`
 * does not save us: the Stop payload is not guaranteed to carry a usable
 * transcript.)
 *
 * Keying on the final message is both safer and more faithful to this guard's
 * signal, which IS that message: the same turn re-entering Stop (the advisory
 * continuation) presents the same text and correctly dedups, while a different
 * turn presents different text and correctly fires.
 *
 * Residual, accepted: two DIFFERENT turns ending with byte-identical text
 * dedup to one warning. That is the right call — identical sign-off, identical
 * advice — and is bounded to a single suppressed beat rather than a session.
 */
function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function turnKeyForMessage(finalMessage: string): string {
  return sha1Short(finalMessage);
}

/**
 * Guard-dispatcher entry point (GuardModule contract). `storeDir` is a test
 * seam for the dedup store location; the dispatcher never passes it.
 */
export function run(
  input: StopHookInput,
  _ctx: DispatchContext,
  storeDir?: string
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[turn-end-untaken-action] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  // Deliberately NOT the transcript-union the retro-scan sibling uses: this
  // guard's whole signal is that the text sits at the END of the turn. Folding
  // in earlier assistant text would match announcements the turn then acted on.
  const finalMessage = input.last_assistant_message ?? "";
  if (!finalMessage) return null;

  const matches = detectUntakenAction(finalMessage);
  if (matches.length === 0) return null;

  const sessionId = input.session_id ?? "unknown";
  const turnKey = turnKeyForMessage(finalMessage);
  const flagged = readFlagged(sessionId, storeDir);
  const newMatches = matches.filter(
    (m) => !flagged.has(flagKey(turnKey, m.family, m.matchedPhrase))
  );
  if (newMatches.length === 0) return null;

  for (const m of newMatches) {
    flagged.add(flagKey(turnKey, m.family, m.matchedPhrase));
  }
  writeFlagged(sessionId, flagged, storeDir);

  // mt#3620: when the same final message ALSO matches the ask-routing-deferral
  // patterns ("say the word" sits in BOTH pattern sets), exactly one of the two
  // guards should speak. THIS one does.
  //
  // mt#3336 originally made this guard yield instead, on the reasoning that the
  // deferral guidance is the more specific of the two. The reasoning holds; the
  // direction did not. The sibling runs on `UserPromptSubmit`, an event that by
  // construction occurs only AFTER the principal has read the closing sentence
  // and typed a reply — so yielding to it traded a warning that could prevent
  // the round-trip for one that can only comment on it afterwards. A dedup
  // between guards on DIFFERENT events is a handoff, and it has to hand toward
  // the EARLIER event.
  //
  // The overlap is recorded in the store instead, and the prompt-time sibling
  // reads it and stays quiet — one closing sentence, one injection, as intended.
  const deferralOverlap = detectDeferralPhrases(finalMessage);
  if (deferralOverlap.length > 0) {
    const overlapKey = overlapTurnKey(finalMessage, sha1Short);
    for (const m of deferralOverlap) {
      flagged.add(flagKey(overlapKey, STOP_INJECTED_OVERLAP_FAMILY, m.matchedPhrase));
    }
    writeFlagged(sessionId, flagged, storeDir);
  }

  return {
    calibration: {
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      stop_hook_active: input.stop_hook_active === true,
      matches: newMatches.map((m) => ({ family: m.family, phrase: m.matchedPhrase })),
      final_message_tail: finalMessage.slice(-TAIL_WINDOW_CHARS),
      // Retained (mt#3620) so the overlap rate stays measurable across the
      // direction change — but it no longer suppresses, so it is reported
      // under its own name and NOT as a suppression reason.
      deferralOverlap: deferralOverlap.length > 0,
      // mt#3207: the shared contract the sweep actually reads. This guard now
      // always injects when it has new matches, so the list is always empty —
      // empty (not absent) still means "recorded an outcome, did not suppress".
      suppressionReasons: [] as string[],
    },
    additionalContext: buildReminder(newMatches),
  };
}
