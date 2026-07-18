#!/usr/bin/env bun
// UserPromptSubmit hook: measure the just-completed turn's FINAL assistant
// text block (the turn-end report) against the Tier-1 turn-report contract
// shape (communication-contract.mdc, mt#2713) and log a calibration record
// when it reads as a wall of text. Per mt#2870.
//
// **Why this exists.** The communication-altitude RFC's Phase 3 enforcement
// half has two sibling failure modes: UNDER-signaling (long silent tool-only
// stretches — the shipped silent-stretch-detector, mt#2824) and
// OVER-signaling (multi-screen turn-end reports that blow the contract's
// budget and lead with skill-internal audit vocabulary — this detector).
// Originating incident: the 2026-07-15 mt#2777 planning output that led with
// a four-part premise audit and a 14-row criterion table, prompting "This is
// too much information."
//
// **Calibration-first (mt#2263 detector ladder / ADR-024).** v1 logs matches
// to JSONL and injects NOTHING — `additionalContext` is never emitted here.
// Graduating to injection is a follow-up decision made after reviewing the
// false-positive rate accumulated in the calibration log.
//
// **Measured signals (v1 — deterministic, no LLM):**
//   - word/line count of the turn's FINAL assistant text block (the report);
//   - skill-internal label patterns (gate/criterion letters, parenthesized
//     roman-numeral premise labels, `SC#N` refs) inside the report's OPENING
//     window — the contract allows them in a trailing audit block, so only
//     the lead is scanned;
//   - `minsky://` deeplink count vs named-artifact refs (`mt#N`, `PR #N`) —
//     the pointer-presence signal (detail should live behind pointers).
//
// **Thresholds.** The contract's Tier-1 budget is verbatim "hard budget:
// readable in under 30 seconds (~200 words)". A record is logged at 2x that
// budget (>= 400 words) — a clear violation, not a borderline expanded
// report (severity legitimately pierces the register; calibration data will
// show how often that happens) — OR on any lead-label hit.
//
// @see .minsky/hooks/silent-stretch-detector.ts — the under-signaling sibling this file mirrors structurally
// @see .minsky/rules/communication-contract.mdc — the Tier-1 contract shape being measured
// @see mt#2263 — detector ladder (calibration before injection)
// @see mt#2713 — the contract this measures against
// @see mt#2870 — this task
// @see .minsky/hooks/registry.ts — ADR-028 GUARD_REGISTRY entry for this guard

import { readInput, readHostCap, deriveBudgets } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { parseTranscript, extractLastAssistantTurn, extractAssistantText } from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after reviewing the FP
 * rate from the calibration log (mt#2263 ladder).
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/**
 * Bespoke opt-out, checked directly inside `run()`/`main()` in addition to
 * the shared `MINSKY_HOOK_OVERRIDE` channel every GUARD_REGISTRY entry gets
 * for free via the dispatcher's `checkOverride()`.
 */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_WALL_OF_TEXT";

const CALIBRATION_LOG = ".minsky/wall-of-text-calibration.jsonl";

// ---------------------------------------------------------------------------
// Thresholds (grounded in the contract — see header comment)
// ---------------------------------------------------------------------------

/** The Tier-1 contract's lead budget, verbatim from communication-contract.mdc. */
export const LEAD_WORD_BUDGET = 200;

/** A record is logged at this multiple of the budget — clear violation, not borderline. */
export const OVER_BUDGET_MULTIPLIER = 2;

/** Word count at which the over-budget trigger fires. */
export const WORD_COUNT_THRESHOLD = LEAD_WORD_BUDGET * OVER_BUDGET_MULTIPLIER;

/**
 * Size of the OPENING window (in words) scanned for skill-internal labels.
 * The contract requires the lead be label-free; a trailing audit block may
 * legitimately carry them, so the scan never extends past this window.
 */
export const LEAD_WINDOW_WORDS = 150;

/**
 * Skill-internal label patterns the contract bars from the lead
 * (communication-contract.mdc: "no skill-internal labels (gate letters (l),
 * premise-audit labels (iii), criterion-table IDs)"). Conservative by
 * design — calibration mode measures the FP rate before any graduation.
 */
export const SKILL_LABEL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // "gate (l)", "criterion (h)", "gate criterion (n)" — audit-battery refs.
  { name: "gate-letter", re: /\b(?:gate|criterion|criteria)\s+(?:criterion\s+)?\(?[a-n]\)/i },
  // "(i)" / "(ii)" / "(iii)" / "(iv)" premise-audit labels. The trailing
  // boundary keeps "(i.e." and similar from matching.
  { name: "premise-label", re: /\((?:i|ii|iii|iv)\)(?:\s|$|[.,:;])/ },
  // "SC#3" success-criterion refs.
  { name: "sc-ref", re: /\bSC#\d+/ },
];

const DEEPLINK_RE = /minsky:\/\//g;
const NAMED_REF_RE = /\bmt#\d+|\bPR\s+#\d+/g;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface WallOfTextMeasurement {
  /** true when either trigger fired. */
  matched: boolean;
  /** Which trigger(s) fired. */
  trigger: "over-budget" | "lead-labels" | "both" | "none";
  /** Word count of the final assistant text block. */
  wordCount: number;
  /** Line count of the final assistant text block. */
  lineCount: number;
  /** Names of SKILL_LABEL_PATTERNS that hit inside the lead window. */
  leadLabelHits: string[];
  /** Count of minsky:// deeplinks anywhere in the report. */
  deeplinkCount: number;
  /** Count of named-artifact refs (mt#N / PR #N) anywhere in the report. */
  namedRefCount: number;
}

/**
 * The turn-end report is the LAST assistant line in the turn that carries
 * non-empty text — the message the principal actually reads as the report.
 * Reuses `extractAssistantText` per-line (it already handles the
 * tool_result-is-user-role hazard and string-vs-content-array shapes).
 */
export function extractFinalAssistantText(turnLines: TranscriptLine[]): string {
  for (let i = turnLines.length - 1; i >= 0; i--) {
    const line = turnLines[i];
    if (!line) continue;
    const text = extractAssistantText([line]);
    if (text.trim().length > 0) return text;
  }
  return "";
}

/** Measure a turn-end report against the Tier-1 contract shape. */
export function measureWallOfText(finalText: string): WallOfTextMeasurement {
  const words = finalText.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lineCount = finalText.split("\n").filter((l) => l.trim().length > 0).length;

  const lead = words.slice(0, LEAD_WINDOW_WORDS).join(" ");
  const leadLabelHits = SKILL_LABEL_PATTERNS.filter((p) => p.re.test(lead)).map((p) => p.name);

  const deeplinkCount = (finalText.match(DEEPLINK_RE) ?? []).length;
  const namedRefCount = (finalText.match(NAMED_REF_RE) ?? []).length;

  const overBudget = wordCount >= WORD_COUNT_THRESHOLD;
  const hasLeadLabels = leadLabelHits.length > 0;
  const matched = overBudget || hasLeadLabels;
  const trigger =
    overBudget && hasLeadLabels
      ? "both"
      : overBudget
        ? "over-budget"
        : hasLeadLabels
          ? "lead-labels"
          : "none";

  return { matched, trigger, wordCount, lineCount, leadLabelHits, deeplinkCount, namedRefCount };
}

// ---------------------------------------------------------------------------
// Calibration logging (standalone CLI path only — dispatcher path uses D4
// `logCalibrationRecord` via the registry's `calibrationLog` wiring)
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
    process.stderr.write(`[wall-of-text-detector] Failed to write calibration log: ${msg}\n`);
  }
}

function buildCalibrationRecord(
  input: ClaudeHookInput,
  m: WallOfTextMeasurement
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    wordCount: m.wordCount,
    lineCount: m.lineCount,
    trigger: m.trigger,
    leadLabelHits: m.leadLabelHits,
    deeplinkCount: m.deeplinkCount,
    namedRefCount: m.namedRefCount,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Reuses `ctx.transcriptLines` (D6) instead of
 * re-parsing the transcript itself. Only calibration logging happens here
 * (via the returned `calibration` field, forwarded to `logCalibrationRecord`
 * per this guard's `calibrationLog: "wall-of-text"` registration) —
 * `additionalContext` is never set while `INJECTION_ENABLED` is false.
 */
export function run(input: ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[wall-of-text-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    return null;
  }
  if (turnLines.length === 0) return null;

  let measurement: WallOfTextMeasurement;
  try {
    const finalText = extractFinalAssistantText(turnLines);
    if (finalText.length === 0) return null;
    measurement = measureWallOfText(finalText);
  } catch (err) {
    process.stderr.write(
      `[wall-of-text-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (!measurement.matched) return null;

  const outcome: GuardOutcome = {
    calibration: buildCalibrationRecord(input, measurement),
  };

  if (INJECTION_ENABLED) {
    // v1 never reaches here — kept structurally symmetric with sibling
    // calibration-first detectors so flipping the flag later is a one-line
    // change plus this reminder-text helper, not a restructure.
    outcome.additionalContext = buildInjectionReminder(measurement);
  }

  return outcome;
}

function buildInjectionReminder(m: WallOfTextMeasurement): string {
  return [
    "[wall-of-text-detector] Turn-end report shape violation detected (mt#2870).",
    "",
    `The prior turn's final report ran ${m.wordCount} words${
      m.leadLabelHits.length > 0
        ? ` and led with skill-internal labels (${m.leadLabelHits.join(", ")}).`
        : "."
    }`,
    "",
    "The Tier-1 turn-report contract (communication-contract.mdc): what happened /",
    "what you need to know / what's next, each 1-3 sentences, ~200 words total,",
    "plain-language lead, detail behind pointers.",
    "",
    `Override: ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Standalone CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("wall-of-text-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[wall-of-text-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

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
      `[wall-of-text-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  if (Date.now() >= overallDeadline) {
    process.stderr.write(
      `[wall-of-text-detector] budget exhausted before transcript read — skipping\n`
    );
    process.exit(0);
  }

  const lines = parseTranscript(transcriptPath);
  if (lines.length === 0) {
    process.exit(0);
  }

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }

  if (turnLines.length === 0) {
    process.exit(0);
  }

  let measurement: WallOfTextMeasurement;
  try {
    const finalText = extractFinalAssistantText(turnLines);
    if (finalText.length === 0) {
      process.exit(0);
    }
    measurement = measureWallOfText(finalText);
  } catch (err) {
    console.error(
      `[wall-of-text-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!measurement.matched) {
    process.exit(0);
  }

  if (Date.now() < overallDeadline) {
    appendCalibrationRecord(input.cwd, buildCalibrationRecord(input, measurement));
  }

  if (!INJECTION_ENABLED) {
    process.exit(0);
  }

  const reminder = buildInjectionReminder(measurement);
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Entrypoint guard: only run main() when this file is invoked as a script —
// the dispatcher's dynamic `import("./wall-of-text-detector")` must NOT
// trigger it (mt#2835 convention; see auto-session-title.ts).
if (import.meta.main) {
  await main();
}
