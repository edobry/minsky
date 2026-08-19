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
import { elideQuotedAndCodeContexts } from "./elision";
import {
  detectTriggerPhrasesWithNomination,
  hasRetrospectiveSkillInvocation,
  OVERRIDE_ENV_VAR,
  rungProvenance,
} from "./retrospective-trigger-scanner";
import type { TriggerMatch } from "./retrospective-trigger-scanner";
import { flagKey, readFlagged, turnKeyFor, writeFlagged } from "./turn-end-scan-store";
import { cappedEvidenceLines } from "./guard-feedback-format";

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

/** Characters of surrounding turn text kept on each side of the anchored phrase. */
const EXCERPT_CONTEXT_CHARS = 80;

/**
 * Which text an excerpt was cut from (mt#4102). `"elided"` means quoted and code
 * spans in it are blanked — it is the residual Rung 2 scored, not the transcript.
 */
export type ExcerptSurface = "raw" | "elided" | "none";

/**
 * Anchor a matched phrase in the turn text and cut the surrounding excerpt.
 *
 * mt#4102: this used to be a bare `text.indexOf(matchedPhrase)`, which is right
 * for a Rung-1 match and wrong for a Rung-3 one. Rung 2 scores — and Rung 3
 * therefore judges — `elideQuotedAndCodeContexts(text)`, so a confirmed match's
 * `matchedPhrase` is a segment of the ELIDED text. Any such phrase crossing an
 * elided span is absent from the raw text, `indexOf` returns -1, and the
 * excerpt was written as `""` with nothing recording why.
 *
 * That empty string was the most expensive field in the record. `calibration-review`
 * requires recovering the judged turn before classifying a `retrospective-trigger`
 * fire precisely BECAUSE the stored phrase is a nomination artifact (mt#3931
 * measured classify-from-phrase inverting the verdict 4/4) — and the excerpt is
 * the only in-record context standing between a reviewer and that recovery. On
 * the 2026-08-13T15:55:49Z record it was empty, the fire read as a false
 * positive for six days, and the recovered turn turned out to open with
 * "you're right that dropping my position under challenge was the wrong move."
 *
 * So: try the raw text, fall back to the elided text (where a Rung-3 phrase
 * lives by construction), and when neither anchors, SAY which failed rather
 * than emitting an empty string that reads as "no context existed."
 */
export function anchorExcerpt(
  text: string,
  matchedPhrase: string
): { text: string; surface: ExcerptSurface; unanchoredReason?: string } {
  const cut = (haystack: string, idx: number): string =>
    haystack.slice(
      Math.max(0, idx - EXCERPT_CONTEXT_CHARS),
      Math.min(haystack.length, idx + matchedPhrase.length + EXCERPT_CONTEXT_CHARS)
    );

  const rawIdx = text.indexOf(matchedPhrase);
  if (rawIdx >= 0) return { text: cut(text, rawIdx), surface: "raw" };

  const elided = elideQuotedAndCodeContexts(text);
  const elidedIdx = elided.indexOf(matchedPhrase);
  if (elidedIdx >= 0) return { text: cut(elided, elidedIdx), surface: "elided" };

  return {
    text: "",
    surface: "none",
    unanchoredReason: "phrase not found in raw or elided turn text",
  };
}

function buildTurnEndReminder(matches: TriggerMatch[]): string {
  const lines: string[] = [
    "[turn-end-retro-scan] Retrospective-trigger phrase detected in the turn you just completed, with no /retrospective invocation in the same turn.",
    "",
  ];
  lines.push(
    ...cappedEvidenceLines(matches, (m) => `  - Family ${m.family}: "${m.matchedPhrase}"`)
  );
  lines.push(
    "",
    "Address this BEFORE ending the turn: invoke `/retrospective` now — its Step 0.5 triage owns whether a full retrospective is warranted. " +
      "If this is genuinely not a retrospective case (e.g. the phrase is not about your own work), say so in one line and end the turn."
  );
  return lines.join("\n");
}

/**
 * Guard-dispatcher entry point (GuardModule contract). `storeDir` is a test
 * seam for the dedup store location; the dispatcher never passes it.
 */
export async function run(
  input: StopHookInput,
  ctx: DispatchContext,
  storeDir?: string
): Promise<GuardOutcome | null> {
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

  // A /retrospective invocation anywhere in the RECORDED completed turn means
  // the admission was already acted on — nothing to remind about. (An
  // invocation sitting only in a not-yet-flushed transcript tail is invisible
  // here by construction — no recorded line carries it; PR #2148 R1. Accepted:
  // the cost is one advisory beat, bounded by the dedup store, and the
  // prompt-time scanner re-applies its own suppression once the tail lands.)
  if (hasRetrospectiveSkillInvocation(turnLines)) return null;

  // Union of transcript-recorded turn text and the directly-supplied final
  // message (the transcript is not guaranteed to include it at Stop time).
  let text = extractAssistantText(turnLines);
  const lastMessage = input.last_assistant_message;
  if (lastMessage && !text.includes(lastMessage)) {
    text = text ? `${text}\n${lastMessage}` : lastMessage;
  }
  if (!text) return null;

  // mt#3408: routed through the shared Rung-1 + Rung-2 entry point rather than
  // calling `detectTriggerPhrases` directly, so this hook inherits embedding
  // nomination by construction. mt#3341's absorbed constraint 4 flagged that
  // inheritance is automatic ONLY for a prose-matcher change — Rung 2 is not
  // one, so the wiring is explicit here.
  const detected = await detectTriggerPhrasesWithNomination(text);
  const matches = detected.matches;
  if (matches.length === 0) {
    // Record a degraded Rung 2 (ADR-024: never silent-skip) AND a log-only
    // nomination, which never reaches `matches` by construction — dropping it
    // would leave the stage unmeasurable, which is the whole reason it runs
    // log-only in the first place.
    if (detected.degradedReason !== undefined || detected.nominatedFamilies.length > 0) {
      return {
        calibration: {
          source: "live",
          channel: "stop",
          timestamp: new Date().toISOString(),
          session_id: input.session_id,
          matches: [],
          nominated_families: detected.nominatedFamilies,
          nomination_enforcing: detected.enforcing === true,
          // mt#3652: the Rung-3 outcome on judged-and-rejected or degraded
          // nominations — the confirm stage's precision signal.
          confirmed_families: detected.confirmedFamilies,
          ...(detected.rung3 !== undefined ? { rung3: detected.rung3 } : {}),
          ...(detected.degradedReason !== undefined
            ? { nomination_degraded: detected.degradedReason }
            : {}),
        },
      };
    }
    return null;
  }

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
  const excerpt = firstMatch
    ? anchorExcerpt(text, firstMatch.matchedPhrase)
    : { text: "", surface: "none" as ExcerptSurface, unanchoredReason: undefined };

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
      matches: newMatches.map((m) => ({
        family: m.family,
        phrase: m.matchedPhrase,
        // mt#4102: WHERE the phrase came from, recorded per match, so a
        // reviewer knows whether it is the reason or a nomination artifact.
        // Three-way, not two — see `rungProvenance`. PR #3163 R1: an earlier
        // revision derived this from `confirmedFamilies` alone, which labelled
        // a raw-ENFORCED Rung-2 nomination `rung1`. Those bypass the confirm
        // stage entirely, so they are in neither set the two-way test looked
        // at — mislabelling a nominated segment as a pattern hit on precisely
        // the path where provenance is load-bearing, which is this task's own
        // defect reproduced one level up.
        ...rungProvenance(m.family, detected.nominatedFamilies, detected.confirmedFamilies),
      })),
      transcript_excerpt: excerpt.text,
      // mt#4102: which TEXT the excerpt was cut from. PR #3163 R1 (non-blocking):
      // an elided-surface excerpt has its quoted and code spans blanked, and a
      // reader taking it for raw transcript context would misread the very
      // records this field exists to make readable. The prompt-time sibling
      // keeps raw/elided identity separately via `captureInjectedInput`; this
      // is the Stop path's equivalent, inline.
      ...(excerpt.text !== "" ? { transcript_excerpt_surface: excerpt.surface } : {}),
      // mt#4102: an empty excerpt used to be indistinguishable from "no
      // context was available"; now it names which anchoring attempts failed.
      ...(excerpt.unanchoredReason !== undefined
        ? { transcript_excerpt_unanchored: excerpt.unanchoredReason }
        : {}),
      // mt#4102: the firing path dropped this while the non-firing path above
      // has always written it — so on precisely the records that FIRED, a
      // reviewer could not see what Rung 2 nominated, which is the signal
      // needed to tune the exemplar set.
      nominated_families: detected.nominatedFamilies,
      nomination_enforcing: detected.enforcing === true,
      // mt#3652: which of this fire's families came through the Rung-3
      // confirm rather than Rung 1.
      confirmed_families: detected.confirmedFamilies,
      ...(detected.rung3 !== undefined ? { rung3: detected.rung3 } : {}),
    },
    additionalContext: buildTurnEndReminder(newMatches),
  };
}
