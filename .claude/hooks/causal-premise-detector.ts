#!/usr/bin/env bun
// UserPromptSubmit hook: detect volunteered causal/mechanism claims about
// tool or system behavior that lack same-turn verification, and log matches
// to a calibration JSONL. Per mt#2216.
//
// This is a CALIBRATION-FIRST hook: in v1 it logs matches and injects
// NOTHING. The injection gate is controlled by INJECTION_ENABLED = false.
// After ~10 fires the FP rate is reviewed; only then flip the flag.
//
// Detector contract:
//   FIRES on a volunteered causal/mechanism claim about TOOL/SYSTEM behavior:
//     - Retrodictive: "X behaved this way because Y", "the reason is Y",
//       "X blocks/causes Y", "X happened because…"
//     - Forward: "running X will do Y", "X is unsafe because…"
//   WHERE Y invokes a structural mechanism (identity / permission / config /
//   algorithm / data-shape) AND the same turn contains NO backing tool call
//   AND NO file:line or node_modules/… citation.
//
//   DOES NOT FIRE when:
//   - A same-turn tool result backs the claim.
//   - A file:line or node_modules/… citation is present.
//
// Originating incidents R1–R5: see memory `3772c77d`.
// @see .claude/hooks/substrate-bypass-detector.ts — sibling pattern (mt#2020)
// @see .claude/hooks/retrospective-trigger-scanner.ts — sibling pattern (mt#2057)
// @see .claude/hooks/transcript.ts — shared turn-boundary helper

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
} from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after reviewing the FP
 * rate from the calibration log.
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_CAUSAL_PREMISE";

const CALIBRATION_LOG = ".minsky/causal-premise-calibration.jsonl";

// ---------------------------------------------------------------------------
// Causal phrase patterns — retrodictive
// ---------------------------------------------------------------------------

/**
 * Retrodictive causal patterns: "X happened because Y", "the reason is Y",
 * "X blocks/causes Y because of Z", etc.
 *
 * These cover volunteered explanations of WHY something happened — the
 * agent is asserting a causal mechanism for past behavior.
 */
export const RETRODICTIVE_PATTERNS: RegExp[] = [
  /\bbecause\s+of\s+(the\s+)?(identity|permission|config(?:uration)?|algorithm|data[- ]shape|ownership|token|role|flag|schema|scope|encoding|mechanism)\b/i,
  /\bthe\s+reason\s+(is|was|it\s+(?:is|was))\b/i,
  /\b(block(?:ed|s)?|prevent(?:ed|s)?|cause[sd]?|fail(?:ed|s)?)\s+because\b/i,
  /\b(due\s+to|owing\s+to)\s+(the\s+)?(identity|permission|config(?:uration)?|algorithm|ownership|token|role|flag|schema|scope|mechanism|policy|encoding)\b/i,
  /\bshares?\s+(the\s+)?(same|author[''']?s?|bot[''']?s?)\s+(identity|token|app|account)\b/i,
  /\b(it[''']?s?|this)\s+(happens?|fails?|blocks?|breaks?|errors?)\s+because\b/i,
  /\bthe\s+(cause|culprit|issue|problem|reason|root\s+cause)\s+(is|was)\b/i,
  /\b(explain|explains?)\s+why\s+(it|the|this)\b/i,
  /\b(mangled|corrupted|truncated|dropped|lost)\s+(by|due\s+to|because)\b/i,
  /\bgot\s+mangled\b/i,
  /\bthe\s+(filter|query|api|request|call)\s+(is\s+)?(ignoring|dropping|mangling|silently)\b/i,
];

// ---------------------------------------------------------------------------
// Causal phrase patterns — forward predictive
// ---------------------------------------------------------------------------

/**
 * Forward predictive causal patterns: "running X will do Y", "X is unsafe
 * because Z", "X would cause Y".
 *
 * These cover the R5 class: the agent predicts future tool behavior based
 * on an unverified mechanism model.
 */
export const FORWARD_PATTERNS: RegExp[] = [
  /\b(running|executing|calling|applying)\s+\S+\s+will\s+(cause|trigger|result\s+in|break|fail|crash|error)\b/i,
  /\bis\s+(unsafe|dangerous|risky)\s+because\b/i,
  /\bwould\s+(cause|trigger|break|fail|crash)\s+(if|when|because|since)\b/i,
  /\b(migrate|apply|run|execute)\s+is\s+(unsafe|dangerous)\b/i,
  /\bwill\s+(no[- ]?op|throw|abort|reject|block)\s+(then|before|and)\b/i,
];

// ---------------------------------------------------------------------------
// Mechanism indicator patterns (Y must invoke a structural mechanism)
// ---------------------------------------------------------------------------

/**
 * These patterns match the "Y" in "X blocked because Y" — the mechanism
 * part of the claim. The detector only fires when a causal phrase matches
 * AND the same turn references a structural mechanism.
 *
 * We use presence in the SAME PARAGRAPH (≤500 chars proximity) for scope.
 */
export const MECHANISM_PATTERNS: RegExp[] = [
  /\b(identit|owner|permission|authori[sz]|token|role|scope|policy)\b/i,
  /\b(config(?:uration)?|setting|flag|env\s*var|variable|schema|data[- ]shape|algorithm|encoding)\b/i,
  /\b(App\s+id|installation|bot\s+id|agent\s+id|user\s+id|service\s+account)\b/i,
  /\b(high[- ]?water[- ]?mark|ledger|journal|timestamp|migration)\b/i,
  /\b(cach[ei]|memoriz|remember|stored|retained|inherit)\b/i,
];

// ---------------------------------------------------------------------------
// Verification presence patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that, when present in the assistant turn, indicate the claim
 * has same-turn backing — tool result, file:line citation, or node_modules
 * reference.
 */
export const VERIFICATION_CITATION_PATTERNS: RegExp[] = [
  // file:line citation (e.g., "compose-review.ts:159-174")
  /\b\w[\w./\\-]+\.\w{1,10}:\d+\b/,
  // node_modules reference
  /node_modules\//,
  // explicit "verified by reading" / "confirmed by" phrasing
  /\bverified\s+by\s+(reading|checking|inspecting|running|calling|looking)\b/i,
  /\bconfirmed\s+by\s+(reading|checking|inspecting|running|calling)\b/i,
  /\bas\s+(shown|confirmed|verified)\s+(by|in)\s+(the\s+)?(tool|output|result)\b/i,
];

/**
 * Tool names that, when present in the same turn's tool_use calls, indicate
 * the agent backed its claim with an actual tool invocation (not just assertion).
 *
 * Any tool call is a potential backing — but we specifically recognize these
 * as strong backing signals since they involve reading real system state.
 */
export const BACKING_TOOL_PREFIXES: string[] = [
  "mcp__github__",
  "mcp__minsky__",
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "mcp__",
];

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface CausalDetectionResult {
  matched: boolean;
  matchedPhrases: string[];
  hadSameTurnVerification: boolean;
}

// ---------------------------------------------------------------------------
// Core detector function (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Detect volunteered causal/mechanism claims without same-turn verification.
 *
 * @param assistantText - full concatenated text from the prior assistant turn
 * @param toolUseNames - list of tool_use names in the same turn
 * @returns detection result with matched phrases and verification flag
 */
export function detectCausalPremise(
  assistantText: string,
  toolUseNames: string[]
): CausalDetectionResult {
  if (!assistantText) {
    return { matched: false, matchedPhrases: [], hadSameTurnVerification: false };
  }

  // Check for same-turn verification via citation patterns
  const hasCitationBacking = VERIFICATION_CITATION_PATTERNS.some((re) => re.test(assistantText));

  // Check for same-turn verification via tool invocations
  const hasToolBacking = toolUseNames.some((name) =>
    BACKING_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );

  const hadSameTurnVerification = hasCitationBacking || hasToolBacking;

  // Apply markdown-aware filtering to skip code blocks / blockquotes
  const filteredText = elideMarkdownContexts(assistantText);

  // Collect matched causal phrases
  const matchedPhrases: string[] = [];

  // Check retrodictive patterns
  for (const pattern of RETRODICTIVE_PATTERNS) {
    const match = pattern.exec(filteredText);
    if (match) {
      // Also verify a mechanism term co-occurs in the same paragraph
      if (hasMechanismInProximity(filteredText, match.index, 500)) {
        matchedPhrases.push(match[0].slice(0, 120));
      }
    }
  }

  // Check forward predictive patterns
  for (const pattern of FORWARD_PATTERNS) {
    const match = pattern.exec(filteredText);
    if (match) {
      if (hasMechanismInProximity(filteredText, match.index, 500)) {
        matchedPhrases.push(match[0].slice(0, 120));
      }
    }
  }

  if (matchedPhrases.length === 0) {
    return { matched: false, matchedPhrases: [], hadSameTurnVerification };
  }

  return {
    matched: true,
    matchedPhrases,
    hadSameTurnVerification,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff a mechanism-indicator pattern matches within `proximityChars`
 * characters of `anchorIndex` in `text`.
 */
function hasMechanismInProximity(
  text: string,
  anchorIndex: number,
  proximityChars: number
): boolean {
  const start = Math.max(0, anchorIndex - proximityChars);
  const end = Math.min(text.length, anchorIndex + proximityChars);
  const slice = text.slice(start, end);
  return MECHANISM_PATTERNS.some((re) => re.test(slice));
}

/**
 * Elide markdown contexts (fenced code blocks, inline code, blockquotes) by
 * replacing with same-length whitespace. Preserves character positions for
 * accurate snippet extraction. Mirrors the implementation in
 * substrate-bypass-detector.ts.
 */
export function elideMarkdownContexts(text: string): string {
  let result = text;

  // Fenced code blocks (``` or ~~~ fences, 3+ markers)
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );

  // Inline code spans (variable backtick run length)
  result = result.replace(/(`+)([^`]|(?!`)[^`]*?)\1(?!`)/g, (m) => " ".repeat(m.length));

  // Blockquote lines (up to 3 leading spaces + one or more > markers)
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));

  return result;
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(cwd, CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[causal-premise-detector] Failed to write calibration log: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED)
// ---------------------------------------------------------------------------

function buildInjectionReminder(matchedPhrases: string[]): string {
  const phraseLines = matchedPhrases.map((p) => `  - "${p}"`).join("\n");
  return [
    "[causal-premise-detector] Unverified causal/mechanism claim detected (mt#2216).",
    "",
    "The prior assistant turn made a causal or mechanism claim about tool/system",
    "behavior without same-turn backing (no tool call, no file:line citation).",
    "",
    "Matched phrases:",
    phraseLines,
    "",
    "Required: invoke /check-premise before asserting. List the premises this",
    "claim rests on and check the cheapest falsifier first (read the installed",
    "source / query the system's own record / grep).",
    "",
    "Memory: 3772c77d. Override: MINSKY_ACK_CAUSAL_PREMISE=1.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[causal-premise-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  const lines = parseTranscript(transcriptPath);
  if (lines.length === 0) {
    process.exit(0);
  }

  let turnLines;
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }

  if (turnLines.length === 0) {
    process.exit(0);
  }

  let result: CausalDetectionResult;
  try {
    const assistantText = extractAssistantText(turnLines);
    const toolUseNames = extractToolUseNames(turnLines);
    result = detectCausalPremise(assistantText, toolUseNames);
  } catch (err) {
    console.error(
      `[causal-premise-detector] Detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!result.matched) {
    process.exit(0);
  }

  // Always log to calibration JSONL
  appendCalibrationRecord(input.cwd, {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    matchedPhrases: result.matchedPhrases,
    hadSameTurnVerification: result.hadSameTurnVerification,
  });

  // Only inject additionalContext when INJECTION_ENABLED is true (v2+)
  if (!INJECTION_ENABLED) {
    process.exit(0);
  }

  const reminder = buildInjectionReminder(result.matchedPhrases);
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
