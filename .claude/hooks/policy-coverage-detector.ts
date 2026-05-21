#!/usr/bin/env bun
// PreToolUse hook — Surface 1 of the System 3* detector (mt#1035 / mt#1541).
//
// Runs before every Edit/Write/NotebookEdit. If the tool call encodes a
// preference-bound choice (per the action filter) AND policy does not cover
// it (per the coverage decision against the in-memory policy corpus), the
// hook emits a `direction.decide` AskIntent and blocks the action with the
// question surfaced via permissionDecisionReason.
//
// Composition:
//   action-filter  — is this a preference-encoding action?
//   corpus-loader  — load the 5 policy sources
//   coverage       — does any source cover the action?
//   emit           — build the DetectionSignal + AskIntent
//
// On uncovered: BLOCK with the operator question.
// On covered:   PERMIT with citation in additionalContext.
// On dismissed signature: PERMIT with "(dismissed)" note in additionalContext.
//
// Calibration: every firing (covered, uncovered, dismissed) appends a line
// to `.minsky/policy-coverage-calibration.jsonl` for firing-rate analysis.
//
// Mode override: set MINSKY_POLICY_COVERAGE_MODE in environment to control behavior:
//   - unset / "log-only" (DEFAULT): always permit; record calibration data.
//   - "block": deny uncovered actions with permissionDecision = "deny".
//   - "disabled": skip entirely (no calibration write either; logs the bypass).
// The hook prints a single audit line to stdout on each `disabled` invocation
// so the bypass is observable in the session transcript.
//
// @see mt#1541 — Surface 1 detector implementation umbrella
// @see mt#1574 — shared Detector core infrastructure (sibling)
// @see mt#1575 — this task (Surface 1 specifics)
// @see docs/research/mt1035-system3-detector.md §Surface 1, §Hook-pipeline integration

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

import {
  applyActionFilter,
  extractToolCallParams,
} from "../../src/domain/detectors/policy-coverage/action-filter";
import { loadPolicyCorpus } from "../../src/domain/detectors/policy-coverage/corpus-loader";
import { decideCoverage } from "../../src/domain/detectors/policy-coverage/coverage";
import type {
  ActionDescriptor,
  CoverageEvidence,
} from "../../src/domain/detectors/policy-coverage/coverage";
import {
  buildDetectionSignal,
  buildEvidenceSignature,
  emitAskIntent,
  DETECTOR_ID,
  DETECTOR_VERSION,
} from "../../src/domain/detectors/policy-coverage/emit";
import type { DetectionContext } from "../../src/domain/detectors/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that the detector evaluates — others are ignored. */
// mt#2029: include MCP-session file-write tools. The agent uses these
// exclusively inside Minsky sessions (per `Git and MCP tool usage` rule:
// session_edit_file not Edit, session_write_file not Write). Without these
// in the matcher set, the detector is structurally blind on the surface
// where the agent actually does its work — six R-incidents of the
// confabulated-strategic-frame family slipped through this gap.
const COVERED_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "mcp__minsky__session_edit_file",
  "mcp__minsky__session_search_replace",
  "mcp__minsky__session_write_file",
]);

/**
 * Mode env var. Three values:
 *   - unset / "log-only" (DEFAULT): always permit; record calibration data.
 *   - "block": block uncovered actions with permissionDecision = "deny".
 *   - "disabled": skip the detector entirely (no calibration write either).
 *
 * v0.1 ships with `log-only` as the default to avoid over-firing during
 * the calibration window per mt#1035 §False-positive risk. Operators flip
 * to `block` after reviewing the calibration log and confirming the firing
 * rate is acceptable.
 */
const MODE_ENV_VAR = "MINSKY_POLICY_COVERAGE_MODE";

type DetectorMode = "log-only" | "block" | "disabled";

function readMode(): DetectorMode {
  const raw = process.env[MODE_ENV_VAR];
  if (raw === "block") return "block";
  if (raw === "disabled") return "disabled";
  return "log-only";
}

/** Calibration log path (relative to repo root). */
const CALIBRATION_LOG = ".minsky/policy-coverage-calibration.jsonl";

/** Local dismissal signature list (relative to repo root). */
const DISMISSALS_FILE = ".minsky/policy-coverage-dismissals.json";

// ---------------------------------------------------------------------------
// File-backed dismissal helper
// ---------------------------------------------------------------------------

/**
 * Read the local dismissals file as a list of evidence signatures.
 *
 * The file format is a single JSON object: `{ "signatures": ["..."] }`.
 * Returns `[]` on any error (file missing, JSON parse failure, etc.) so the
 * detector defaults to fire-and-block rather than silently suppress.
 *
 * Synchronous because the hook runs before the tool call and must not yield.
 */
export function readLocalDismissals(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "signatures" in parsed &&
      Array.isArray((parsed as { signatures: unknown }).signatures)
    ) {
      const signatures = (parsed as { signatures: unknown[] }).signatures;
      return signatures.filter((s): s is string => typeof s === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Append a calibration record to the calibration log.
 *
 * Records are JSONL — one JSON object per line. Failure to write is
 * non-fatal: we log a stderr message and continue so the hook never
 * blocks the host on calibration-IO problems.
 */
export function appendCalibrationRecord(logPath: string, record: Record<string, unknown>): void {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[policy-coverage-detector] Failed to write calibration log: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Permit-with-citation message
// ---------------------------------------------------------------------------

/**
 * Format the additionalContext message shown when policy covers an action.
 *
 * Surfaces the matching source + line range so the operator can audit the
 * coverage decision without re-reading the policy file.
 */
export function formatPermitMessage(evidence: readonly CoverageEvidence[]): string {
  const lines: string[] = [`[policy-coverage-detector] Action covered by policy:`];
  for (const ev of evidence) {
    lines.push(
      `  ${ev.policySource}:${ev.lineRange[0]}-${ev.lineRange[1]} (matched: ${ev.matchedCategory} + ${ev.matchedAuthority})`
    );
  }
  return lines.join("\n");
}

/**
 * Format the deny reason shown when no policy covers an action.
 *
 * The text is what the operator will see — phrased as the `direction.decide`
 * question with the Ask options enumerated for response.
 */
export function formatBlockMessage(
  question: string,
  signature: string,
  options: ReadonlyArray<{ label: string; description?: string }>
): string {
  const lines: string[] = [
    `[policy-coverage-detector] Surface 1 detector: this action is preference-bound and no policy covers it.`,
    "",
    `Question: ${question}`,
    "",
    `Signature: ${signature}`,
    "",
    `Options:`,
  ];
  for (const opt of options) {
    if (opt.description) {
      lines.push(`  - ${opt.label} — ${opt.description}`);
    } else {
      lines.push(`  - ${opt.label}`);
    }
  }
  lines.push("");
  lines.push(
    `To dismiss this signature permanently, append "${signature}" to the "signatures" array in ${DISMISSALS_FILE}.`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const mode = readMode();

  // Audit log on every PreToolUse invocation: makes the active mode
  // observable in the session transcript so operators can confirm what's
  // running without diff-checking the hook source. Per PR #951 R2.
  process.stdout.write(`[policy-coverage-detector] mode=${mode} tool=${input.tool_name}\n`);

  if (mode === "disabled") {
    process.exit(0);
  }

  // Only fire on Edit/Write/NotebookEdit
  if (!COVERED_TOOL_NAMES.has(input.tool_name)) {
    process.exit(0);
  }

  // Apply action filter
  const params = extractToolCallParams(input.tool_name, input.tool_input);
  const filterResult = applyActionFilter(params);

  if (!filterResult.fires) {
    process.exit(0);
  }

  const action: ActionDescriptor = {
    reason: filterResult.reason,
    detail: filterResult.detail,
    filePath: params.filePath,
  };

  // Resolve repo root from cwd (the parent agent's working directory).
  const repoRoot = resolve(input.cwd);

  // Skip detector's own infra paths to avoid recursion / self-blocks.
  if (
    action.filePath &&
    (action.filePath.includes(".minsky/policy-coverage-") ||
      action.filePath.endsWith("policy-coverage-detector.ts") ||
      action.filePath.includes("/policy-coverage/"))
  ) {
    process.exit(0);
  }

  // Load policy corpus. taskId is optional; in the hook context we don't
  // have a reliable way to determine the active task ID, so we leave it
  // unset for v0.1. CLAUDE.md + rules + memories cover most policy.
  const corpus = await loadPolicyCorpus({ projectRoot: repoRoot });

  // Run coverage decision
  const coverage = decideCoverage(action, corpus);

  // Build the DetectionContext for AskIntent emission (used in calibration too)
  const ctx: DetectionContext = {
    surface: "pre-tool",
    agentId: input.agent_id ?? "unknown",
    sessionId: input.session_id,
    toolCall: {
      toolName: input.tool_name,
      params: input.tool_input,
    },
  };

  const baseRecord = {
    timestamp: new Date().toISOString(),
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    toolName: input.tool_name,
    reason: action.reason,
    filePath: action.filePath,
    sessionId: input.session_id,
    agentId: input.agent_id,
  };
  const calibLog = join(repoRoot, CALIBRATION_LOG);

  // Permit path: covered
  if (coverage.covered) {
    appendCalibrationRecord(calibLog, {
      ...baseRecord,
      outcome: "covered",
      evidence: coverage.evidence,
    });
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: formatPermitMessage(coverage.evidence),
      },
    });
    process.exit(0);
  }

  // Uncovered — check dismissal
  const signature = buildEvidenceSignature(action);
  const dismissalsPath = join(repoRoot, DISMISSALS_FILE);
  const dismissed = readLocalDismissals(dismissalsPath).includes(signature);

  if (dismissed) {
    appendCalibrationRecord(calibLog, {
      ...baseRecord,
      outcome: "dismissed",
      signature,
    });
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[policy-coverage-detector] Action uncovered but signature ${signature} dismissed — permitting.`,
      },
    });
    process.exit(0);
  }

  // Uncovered: build signal + AskIntent for calibration; in `block` mode also deny.
  const signal = buildDetectionSignal(action, input.tool_name, input.tool_input);
  const askIntent = emitAskIntent(signal, ctx);

  appendCalibrationRecord(calibLog, {
    ...baseRecord,
    outcome: mode === "block" ? "uncovered-blocked" : "uncovered-logged",
    mode,
    signature,
    signal,
    askIntent,
  });

  if (mode === "log-only") {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[policy-coverage-detector] log-only: would block (signature ${signature}, reason ${action.reason}). Set ${MODE_ENV_VAR}=block to enforce.`,
      },
    });
    process.exit(0);
  }

  const denyReason = formatBlockMessage(
    signal.suggestedQuestion ?? signal.summary,
    signature,
    signal.suggestedOptions ?? []
  );

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReason,
    },
  });
  process.exit(0);
}
