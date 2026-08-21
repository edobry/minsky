#!/usr/bin/env bun
// Stop-event guard: catch a turn that REPORTS an operator-only incident and
// ends without filing a severity ask (mt#3593).
//
// WHAT CHANGED UNDER THIS GUARD'S FEET:
//   The original mt#3593 spec keyed on the absence of a `principal_notify`
//   call. mt#3595 then made a severity-marked ask notify the principal BY
//   ITSELF, and amended `communication-contract.mdc §Severity transport
//   binding` to tell agents explicitly NOT to send a separate notify. So the
//   original predicate would now fire on every CORRECTLY-handled incident and
//   push the agent toward an action the rule forbids. The absence this guard
//   checks is therefore the ASK, not the notification.
//
// WHY PHRASE-GATED RATHER THAN PURE STATE:
//   `turn-end-unwalked-task-scan` keys purely on tool-call state because a
//   `tasks_create` call IS its trigger. There is no tool call that means "an
//   incident happened" — the trigger only exists in what the agent SAID. So
//   this guard is a hybrid: phrase-gated trigger, state-checked absence. That
//   phrase dependency is a genuine Rung-1 exposure under ADR-024's ladder
//   (recall misses to paraphrase), named here rather than discovered later as
//   a complaint. The ABSENCE half is structural, which is the half that
//   previously produced false confidence.
//
// FAMILY:
//   `family:severity-transport-binding`. R1 mt#3433 (reviewer outage) and R2
//   2026-08-03 (self-inflicted production outage) both had the agent diagnose
//   correctly, determine remediation was operator-only, and tell nobody who
//   could act. mt#3436 shipped the rule as always-loaded prose and R2 happened
//   three days later with that text verbatim in context. mt#3595 shipped the
//   substrate half (the ask now notifies); this is the backstop for the case
//   mt#3595 structurally cannot see — an agent that files NOTHING.
//
// ADVISORY-ONLY, never `deny`: a Stop guard cannot block a tool call, and the
// remedy is one action. The continuation gives the agent the beat to take it.
//
// @see .minsky/hooks/turn-end-unwalked-task-scan.ts — the state-keyed template
// @see .minsky/hooks/turn-end-untaken-action-scan.ts — the phrase-keyed sibling
// @see docs/architecture/adr-031-guidance-detector-lifecycle-event.md
//      ("The lifecycle event the guidance-detector family scans on") — cited by
//      TITLE because the number is contested (mt#3613 is renumbering a duplicate)
// @see mt#3593 — this guard; mt#3595 — the substrate half; mem#779 — R1/R2

import type { DispatchContext, GuardOutcome } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";
import { flagKey, readFlagged, writeFlagged } from "./turn-end-scan-store";
import { elideQuotedAndCodeContexts } from "./elision";
import { extractFinalTurn, findToolUseInputs } from "./transcript";
// From @minsky/shared, a dependency-free leaf package — the lightest place to
// share this helper. (The former reason given here, that hooks must avoid `src/`
// so a type-check failure cannot break them, was retired by mt#4373: Bun strips
// types at import and never type-checks, so that failure mode does not exist.
// `@minsky/shared` is still the right import — now because it is light, not
// because heavier ones are forbidden.)
import { safeTruncate } from "@minsky/shared/safe-truncate";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_UNESCALATED_INCIDENT";

/** The call that discharges the obligation. */
export const ASK_TOOL = "mcp__minsky__asks_create";

/** The marker on that call which makes the substrate notify the principal. */
export const SEVERITY_INCIDENT = "incident";

/**
 * How much of the final message's tail to scan.
 *
 * Wider than the untaken-action guard's 600: that guard looks for a SIGN-OFF,
 * which is by nature the last thing said. An incident report states the
 * situation and then often continues into diagnosis, so the trigger sentence
 * can sit well above the final line.
 */
export const TAIL_WINDOW_CHARS = 1500;

/**
 * How much of the final message the calibration record keeps, so a reviewer
 * classifying a false positive can see the surrounding prose. Narrower than
 * the scan window — the record is for reading, not re-matching.
 */
export const CALIBRATION_TAIL_CHARS = 600;

/**
 * Vocabulary indicating the turn reported an incident.
 *
 * Derived from the two real incidents, not invented: R2's turn said production
 * was down and the service was unhealthy; R1's said the reviewer had been
 * failing every review. Kept narrow on purpose — this is the TRIGGER half, and
 * a loose trigger makes the guard fire on ordinary deploy chatter.
 */
const INCIDENT_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = [
  { family: "prod-down", re: /\b(production|prod)\s+(is\s+)?(down|broken|unavailable)\b/i },
  { family: "broke-prod", re: /\b(broke|took\s+down)\s+(production|prod)\b/i },
  { family: "outage", re: /\b(outage|production\s+incident)\b/i },
  { family: "unhealthy", re: /\b(unhealthy|crash-?looping|failing\s+every)\b/i },
  { family: "persistence-unavailable", re: /\bpersistence[^.\n]{0,40}unavailable\b/i },
];

/**
 * Vocabulary indicating remediation is the PRINCIPAL's, not the agent's.
 *
 * Both halves are required. An incident the agent can fix itself does not
 * warrant spending the principal's attention, which is the same two-part test
 * the `severity` marker itself carries.
 */
const OPERATOR_ONLY_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = [
  { family: "i-cannot", re: /\bi\s+(can'?t|cannot|am\s+unable\s+to)\s+\w+/i },
  { family: "needs-you", re: /\b(i\s+need\s+you|needs?\s+your|requires?\s+you(r)?)\b/i },
  { family: "you-run", re: /\byou'?ll?\s+(need\s+to|have\s+to)\s+(run|do|push|flush)\b/i },
  { family: "only-you", re: /\bonly\s+you\s+(can|could)\b/i },
  { family: "say-the-word", re: /\bsay\s+the\s+word\b/i },
  { family: "sudo", re: /\bneeds?\s+(your\s+)?sudo\b/i },
];

export interface IncidentSignal {
  family: string;
  phrase: string;
}

export interface UnescalatedIncident {
  incident: IncidentSignal[];
  operatorOnly: IncidentSignal[];
}

function matchAll(
  text: string,
  patterns: ReadonlyArray<{ family: string; re: RegExp }>
): IncidentSignal[] {
  const out: IncidentSignal[] = [];
  for (const { family, re } of patterns) {
    const m = re.exec(text);
    if (m) out.push({ family, phrase: m[0] });
  }
  return out;
}

/**
 * Did this turn file an ask that makes the substrate notify the principal?
 *
 * Reads the ARGUMENT, not merely the call: an `asks_create` without
 * `severity: "incident"` produces an inbox entry and no notification, which is
 * exactly the R1 shape (ask filed, principal never told). A call that discharges
 * nothing must not read as discharge.
 */
export function turnFiledSeverityAsk(turnLines: Parameters<typeof findToolUseInputs>[0]): boolean {
  for (const input of findToolUseInputs(turnLines, ASK_TOOL)) {
    if (input["severity"] === SEVERITY_INCIDENT) return true;
  }
  return false;
}

/**
 * Pure detector — exported for tests.
 *
 * Elides quoted spans and code before matching, so a turn DISCUSSING this guard
 * (or quoting an incident report) does not trip it. That precision fix is
 * ADR-024's Rung 1 and the reason the family's earlier false positives —
 * "I should have caught" fired three times on agents merely quoting it — are
 * not repeated here.
 */
export function detectUnescalatedIncident(
  finalMessage: string,
  turnLines: Parameters<typeof findToolUseInputs>[0]
): UnescalatedIncident | null {
  const tail = finalMessage.slice(-TAIL_WINDOW_CHARS);
  const prose = elideQuotedAndCodeContexts(tail);

  const incident = matchAll(prose, INCIDENT_PATTERNS);
  if (incident.length === 0) return null;

  const operatorOnly = matchAll(prose, OPERATOR_ONLY_PATTERNS);
  if (operatorOnly.length === 0) return null;

  if (turnFiledSeverityAsk(turnLines)) return null;

  return { incident, operatorOnly };
}

function buildReminder(found: UnescalatedIncident): string {
  const lines: string[] = [
    "[turn-end-unescalated-incident] You reported an incident only the principal can fix, " +
      "and ended the turn without filing an ask that reaches them.",
    "",
  ];
  for (const s of found.incident.slice(0, 2)) lines.push(`  - incident: "${s.phrase}"`);
  for (const s of found.operatorOnly.slice(0, 2)) lines.push(`  - operator-only: "${s.phrase}"`);
  lines.push(
    "",
    'File it now: asks_create with severity: "incident" — that alone sends the notification, so ' +
      "do NOT also send a separate one. Add forceImmediate: true for the unrelated reason that " +
      "it stops the ask waiting for the next service window; the notification does not depend " +
      "on it. If the principal is already replying in this conversation, or the remediation is " +
      "actually yours to do, say which in one line and end."
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
        `[turn-end-unescalated-incident] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const finalMessage = input.last_assistant_message ?? "";
  if (finalMessage.length === 0) return null;

  const { turnLines } = extractFinalTurn(ctx.transcriptLines ?? []);
  const found = detectUnescalatedIncident(finalMessage, turnLines);
  if (!found) return null;

  // Dedup on the matched incident phrase, not the turn: the advisory
  // continuation re-enters Stop with the same message, and one incident should
  // draw one reminder. A LATER, differently-worded incident fires again.
  const sessionId = input.session_id ?? "unknown";
  const key = flagKey(found.incident.map((s) => s.phrase).join("|"), "unescalated-incident", "");
  const flagged = readFlagged(sessionId, storeDir);
  if (flagged.has(key)) return null;
  flagged.add(key);
  writeFlagged(sessionId, flagged, storeDir);

  return {
    calibration: {
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      stop_hook_active: input.stop_hook_active === true,
      incidentFamilies: found.incident.map((s) => s.family),
      operatorOnlyFamilies: found.operatorOnly.map((s) => s.family),
      final_message_tail: safeTruncate(finalMessage, CALIBRATION_TAIL_CHARS, "tail"),
      suppressionReasons: [],
    },
    additionalContext: buildReminder(found),
  };
}
