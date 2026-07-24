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
import { flagKey, readFlagged, turnKeyFor, writeFlagged } from "./turn-end-scan-store";
import { extractFinalTurn } from "./transcript";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_UNTAKEN_ACTION";

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
 */
export function detectUntakenAction(finalMessage: string): UntakenActionMatch[] {
  if (!finalMessage) return [];

  for (const s of SUPPRESSION_PATTERNS) {
    if (s.test(finalMessage)) return [];
  }

  const tail =
    finalMessage.length > TAIL_WINDOW_CHARS
      ? finalMessage.slice(finalMessage.length - TAIL_WINDOW_CHARS)
      : finalMessage;

  const matches: UntakenActionMatch[] = [];
  for (const { family, re } of COMMITMENT_PATTERNS) {
    const m = re.exec(tail);
    if (m) matches.push({ family, matchedPhrase: m[0] });
  }
  return matches;
}

function buildReminder(matches: UntakenActionMatch[]): string {
  const lines: string[] = [
    "[turn-end-untaken-action] This turn ends by naming a next action without taking it.",
    "",
  ];
  for (const m of matches) {
    lines.push(`  - ${m.family}: "${m.matchedPhrase}"`);
  }
  lines.push(
    "",
    "If that action is executable NOW, execute it in this continuation instead of ending the turn — " +
      "then report what happened. Announcing an action and stopping is the mt#3179 failure (R2 asked " +
      "permission, R3 announced intent; both left the work untaken). If the action genuinely cannot " +
      "proceed — you are blocked on a principal decision, a red check, or an external condition you " +
      "have already armed a watcher for — say which in one line and end the turn. This fires at most " +
      `once per phrase per turn. Override: set ${OVERRIDE_ENV_VAR}=1.`
  );
  return lines.join("\n");
}

/**
 * Guard-dispatcher entry point (GuardModule contract). `storeDir` is a test
 * seam for the dedup store location; the dispatcher never passes it.
 */
export function run(
  input: StopHookInput,
  ctx: DispatchContext,
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
  const { openingPrompt } = extractFinalTurn(ctx.transcriptLines);
  const turnKey = turnKeyFor(openingPrompt);
  const flagged = readFlagged(sessionId, storeDir);
  const newMatches = matches.filter(
    (m) => !flagged.has(flagKey(turnKey, m.family, m.matchedPhrase))
  );
  if (newMatches.length === 0) return null;

  for (const m of newMatches) {
    flagged.add(flagKey(turnKey, m.family, m.matchedPhrase));
  }
  writeFlagged(sessionId, flagged, storeDir);

  return {
    calibration: {
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      stop_hook_active: input.stop_hook_active === true,
      matches: newMatches.map((m) => ({ family: m.family, phrase: m.matchedPhrase })),
      final_message_tail: finalMessage.slice(-TAIL_WINDOW_CHARS),
    },
    additionalContext: buildReminder(newMatches),
  };
}
