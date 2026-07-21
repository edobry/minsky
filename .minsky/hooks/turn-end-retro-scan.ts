#!/usr/bin/env bun
// Stop-event guard: scan the just-completed turn for retrospective-trigger
// phrases (R1–R5) at TURN END, and remind the agent — via an advisory
// Stop-hook continuation — to address an unaddressed admission before the
// turn actually ends. The framework's FIRST Stop-event guard (mt#2357,
// scoped via ask#9 option B).
//
// Why turn-end at all: the prompt-time retrospective-trigger-scanner scans
// the completed turn at the NEXT user prompt — which requires a next prompt
// to exist. A trigger phrase in a conversation's FINAL turn (the operator
// reads the tail, closes the session) dies silently. Per hooks.md, injected
// Stop-hook feedback ("Stop hook feedback") continues the conversation one
// beat, so the AGENT gets to act on the admission (invoke /retrospective,
// file the task) with no operator attention required.
//
// Advisory-only by design: never `decision: "block"` in v1 — this detector
// family is Rung-1 regex (ADR-024 ladder) and a blocking Stop hook would
// amplify any false positive from a noise line into a hijacked turn.
//
// Scan input = transcript final turn ∪ `last_assistant_message`: hooks.md
// documents that the transcript file is NOT guaranteed to include the final
// assistant message at Stop time, but the Stop payload carries it directly
// as `last_assistant_message` — so the union covers the whole turn even
// when the transcript lags.
//
// Dedup (`./turn-end-scan-store.ts`) makes each (turn, family, phrase)
// fire AT MOST ONCE across this guard's own re-invocations (Stop fires
// again after the advisory continuation) AND the prompt-time scanner's
// later re-scan of the same turn. A false positive therefore costs exactly
// one visible extra beat.
//
// @see .minsky/hooks/retrospective-trigger-scanner.ts — shared matcher (elision + meta-suppression) + the prompt-time sibling
// @see .minsky/hooks/dispatch-stop.ts — the Stop dispatcher entrypoint
// @see docs/architecture/hooks/turn-end-retro-scan.md — full doc
// @see mt#2357 — originating task; mt#2467 (subsumed) — the boundary-bug FP this task's transcript.ts fix resolves

import type { ClaudeHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { extractAssistantText, extractFinalTurn } from "./transcript";
import {
  detectTriggerPhrases,
  hasRetrospectiveSkillInvocation,
  OVERRIDE_ENV_VAR,
} from "./retrospective-trigger-scanner";
import type { TriggerMatch } from "./retrospective-trigger-scanner";
import { flagKey, readFlagged, turnKeyFor, writeFlagged } from "./turn-end-scan-store";

/**
 * Stop-event payload fields beyond the base `ClaudeHookInput` (hooks.md
 * §Stop input). `stop_hook_active` is true when the conversation is already
 * continuing because of a Stop hook; `last_assistant_message` carries the
 * final response text directly (the transcript may not include it yet).
 */
export interface StopHookInput extends ClaudeHookInput {
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

function buildTurnEndReminder(matches: TriggerMatch[]): string {
  const lines: string[] = [
    "[turn-end-retro-scan] Retrospective-trigger phrase detected in the turn you just completed, with no /retrospective invocation in the same turn.",
    "",
  ];
  for (const m of matches) {
    lines.push(`  - Family ${m.family}: "${m.matchedPhrase}"`);
  }
  lines.push(
    "",
    "Address this BEFORE ending the turn: invoke `/retrospective` now — its Step 0.5 triage owns whether a full retrospective is warranted. " +
      "If this is genuinely not a retrospective case (e.g. the phrase is not about your own work), say so in one line and end the turn — " +
      "this reminder fires at most once per phrase and will not repeat. " +
      `Override: set ${OVERRIDE_ENV_VAR}=1.`
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
        `[turn-end-retro-scan] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const { turnLines, openingPrompt } = extractFinalTurn(ctx.transcriptLines);

  // A /retrospective invocation anywhere in the completed turn means the
  // admission was already acted on — nothing to remind about.
  if (turnLines.length > 0 && hasRetrospectiveSkillInvocation(turnLines)) return null;

  // Union of transcript-recorded turn text and the directly-supplied final
  // message (the transcript is not guaranteed to include it at Stop time).
  let text = extractAssistantText(turnLines);
  const lastMessage = input.last_assistant_message;
  if (lastMessage && !text.includes(lastMessage)) {
    text = text ? `${text}\n${lastMessage}` : lastMessage;
  }
  if (!text) return null;

  const matches = detectTriggerPhrases(text);
  if (matches.length === 0) return null;

  const sessionId = input.session_id ?? "unknown";
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

  const firstMatch = newMatches[0];
  let transcriptExcerpt = "";
  if (firstMatch) {
    const idx = text.indexOf(firstMatch.matchedPhrase);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + firstMatch.matchedPhrase.length + 80);
      transcriptExcerpt = text.slice(start, end);
    }
  }

  return {
    calibration: {
      // source: "live" — a real runtime fire (mt#2554 coverage-receipt gate).
      // channel: "stop" discriminates turn-end fires from the prompt-time
      // scanner's records in the shared retrospective-trigger calibration log.
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      stop_hook_active: input.stop_hook_active === true,
      matches: newMatches.map((m) => ({ family: m.family, phrase: m.matchedPhrase })),
      transcript_excerpt: transcriptExcerpt,
    },
    additionalContext: buildTurnEndReminder(newMatches),
  };
}
