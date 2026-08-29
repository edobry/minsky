#!/usr/bin/env bun
// PreToolUse hook: detect a BARE PROHIBITION in a raw `Agent`-tool dispatch prompt — an
// instruction telling the subagent NOT to do something without stating the basis (mt#3162,
// narrowed by mt#3167; a missing licence-to-falsify no longer qualifies on its own — see
// "What it detects" below).
//
// ## Why this path is required, not optional
//
// mt#2488 shipped a tier-1 evidence gate at the `tasks_dispatch` boundary: every dispatch must
// supply `premiseClaim` / `premiseFalsifier` / `premiseEvidence`. mt#3162 extends that gate to
// cover prohibitions in the `instructions` body. But that gate can only bind dispatches that
// actually CROSS `tasks_dispatch` — and the incident that motivates this whole mechanism did
// not.
//
// Verified 2026-07-24 against the live `subagent_invocations` table: the sole row for mt#3120
// carries `agent_type = "unknown"` (the `UNKNOWN_AGENT_TYPE` Stop-hook sentinel), a null
// `suggested_model`, a null `session_id`, and `started_at == ended_at`. Per the table's schema
// docblock, the Stop hook only INSERTs such a row when no dispatch row existed to UPDATE — so
// no `tasks_dispatch` call was ever made. The prohibition travelled through the raw `Agent`
// tool. An in-process-only gate would have shipped believing it covered its own motivating
// incident, which is precisely the false-coverage this failure family is about.
//
// ## What it detects
//
// The SHAPE of a bare prohibition, via the shared detector in
// `packages/domain/src/validation/negative-constraint.ts` — the SAME module the `tasks_dispatch`
// `structuralCheck` uses, so the two paths cannot drift:
//
//   - a prohibition phrase ("do not attempt", "is blocked", "is not possible", ...), AND
//   - no basis marker within a bidirectional window around it.
//
// Narrowed 2026-08-08 (mt#3167): a missing licence-to-falsify marker USED to qualify on its own.
// Calibration measured that category at 8/8 false positives — it fired on scope decisions, fan-out
// role constraints, and guard-backed policy, where licensing the recipient to falsify would be
// wrong rather than diligent. `has_licence_to_falsify` is still recorded, just not fired on.
//
// It cannot judge whether a stated basis is TRUE, or whether a prohibition is warranted. The
// bet is that requiring the SHAPE is cheap and that the shape is what makes a wrong negative
// conclusion recoverable by its recipient (mem#702: the mt#3120 prompt carried both properties,
// and the subagent used exactly that latitude to override the instruction and cite the
// precedent it named).
//
// ## Reads tool_input, not the transcript
//
// This is a PreToolUse hook on the Agent tool, so the prompt arrives directly as
// `tool_input.prompt`. It does NOT parse the transcript, and therefore is structurally immune
// to the mem#528 class of bug (tool-result lines carry `role: "user"`, silently breaking
// last-assistant-turn extraction) that has left sibling transcript-scanning detectors dead.
//
// ## CALIBRATION-FIRST
//
// `ENFORCEMENT_ENABLED` (shared with the `tasks_dispatch` path) is false in v1: this hook
// RECORDS matches to a calibration log and ALLOWS the dispatch. The pattern set's real-world
// false-positive rate is unmeasured, and blocking on an unmeasured regex trains callers to route
// around the gate. (The generic `skip X` and `avoid using` patterns v1 originally carried were
// REMOVED before merge — PR #2260 R1 — so there is no deliberate noise floor here.) Graduation —
// the per-pattern FP review and the flip/tune/retire decision — is mt#3167.
//
// @see mt#3162 — this hook's task
// @see mt#3167 — calibration graduation
// @see mem#702 (`e437d993`) — the originating incident and the asymmetry this encodes
// @see mt#2488 — the tier-1 evidence gate this is the harness-side twin of
// @see .minsky/hooks/block-nested-fork-dispatch.ts — sibling PreToolUse guard on the Agent tool
// @see .minsky/rules/hook-observers.mdc "Bare-prohibition dispatch"

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { recordFireLogEntry, classifyOverride } from "./fire-log";
import {
  analyzeNegativeConstraints,
  buildBareProhibitionMessage,
  ENFORCEMENT_ENABLED,
} from "../../packages/domain/src/validation/negative-constraint";
import type { NegativeConstraintReport } from "../../packages/domain/src/validation/negative-constraint";
import { logCalibrationRecord } from "./dispatcher";

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit an audit line. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_BARE_PROHIBITION";

/** Calibration log path, relative to the repo root. */
const CALIBRATION_LOG_NAME = "bare-prohibition";

/** The `tool_input` field carrying the dispatch prompt for the Agent tool. */
export const PROMPT_FIELD = "prompt";

/** True when the override env var is set to a recognized truthy value. */
export function isOverrideActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OVERRIDE_ENV_VAR];
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Extract the dispatch prompt from an Agent-tool call. Returns null when the field is absent or
 * not a non-empty string — a malformed input is never this hook's problem to report.
 */
export function extractPrompt(input: ToolHookInput): string | null {
  const raw = input.tool_input?.[PROMPT_FIELD];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw;
}

export type BareProhibitionDecision =
  | {
      decision: "allow";
      reason: string;
      /**
       * The enforcement flag ACTUALLY used for this decision (PR #2260 R1). Carried on the
       * result rather than re-read from the module constant downstream, so the calibration
       * record can never disagree with the behavior it is describing — the exact defect R1
       * caught: `buildCalibrationRecord` logged the constant while the decision had used an
       * injected value.
       */
      enforcementEnabled: boolean;
      report?: NegativeConstraintReport;
    }
  | {
      decision: "deny";
      reason: string;
      enforcementEnabled: boolean;
      report: NegativeConstraintReport;
    };

/**
 * Core decision logic (pure — exported for testing). Mirrors the sibling guards' shape: every
 * exit states a reason, and the calibration gate is the LAST thing consulted so a match is
 * recorded even when it does not block.
 */
export function decideBareProhibitionGate(
  input: ToolHookInput,
  env: NodeJS.ProcessEnv = process.env,
  enforcementEnabled: boolean = ENFORCEMENT_ENABLED
): BareProhibitionDecision {
  if (isOverrideActive(env)) {
    return {
      decision: "allow",
      reason: `${OVERRIDE_ENV_VAR} override active`,
      enforcementEnabled,
    };
  }

  const prompt = extractPrompt(input);
  if (prompt === null) {
    return {
      decision: "allow",
      reason: "no prompt on this Agent-tool call",
      enforcementEnabled,
    };
  }

  const report = analyzeNegativeConstraints(prompt);
  if (report.bare.length === 0) {
    return {
      decision: "allow",
      reason: "no bare prohibition detected",
      enforcementEnabled,
      report,
    };
  }

  if (!enforcementEnabled) {
    return {
      decision: "allow",
      reason: `bare prohibition detected (${report.bare.length}) — calibration mode, not blocking`,
      enforcementEnabled,
      report,
    };
  }

  return {
    decision: "deny",
    reason: buildBareProhibitionMessage(report),
    enforcementEnabled,
    report,
  };
}

/** Append one calibration record; never throws (a logging failure must not break a dispatch). */
export function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  // mt#4752: the shared helper derives the path from the stream NAME, so the
  // filename cannot drift from the convention the .gitignore globs encode.
  // `cwd` is the guard's raw input cwd — a FALLBACK, never an authoritative
  // root (see `calibrationLogPath`'s docblock for why the two ranks differ).
  logCalibrationRecord(CALIBRATION_LOG_NAME, record, { fallbackCwd: cwd });
}

/**
 * Build the calibration record for a report, in the shared "matches"-shape family.
 *
 * `enforcementEnabled` is a REQUIRED parameter, not a module-constant read (PR #2260 R1): the
 * logged flag must describe the decision that actually happened.
 */
export function buildCalibrationRecord(
  input: ToolHookInput,
  report: NegativeConstraintReport,
  enforcementEnabled: boolean
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    enforcement_enabled: enforcementEnabled,
    has_licence_to_falsify: report.hasLicenceToFalsify,
    matches: report.bare.map((f) => ({
      // Constant since mt#3167 retired `no-licence` from the fire path (8/8 measured FP). The
      // field stays so records written before and after the narrowing remain comparable.
      category: "no-basis",
      phrase: f.phrase,
      excerpt: f.excerpt,
      hasBasis: f.hasBasis,
    })),
  };
}

if (import.meta.main) {
  const startedAt = Date.now();

  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    process.exit(0);
  }

  /**
   * mt#3519: record every INVOCATION in the fire log, not just every fire.
   *
   * This guard is standalone (wired directly in `.claude/settings.json`), so it
   * never got the dispatcher's automatic recording — it appeared zero times in
   * the fire log. Without invocation evidence the coverage-receipt check cannot
   * tell "running with nothing to say" from "not running at all" (mt#3502's
   * three-state model), so `bare-prohibition` could only ever be reported as
   * unmapped, and would flag the moment its records aged out of the window.
   *
   * Mirrors `policy-coverage-detector.ts`'s `finishRun` — recorded on EVERY
   * exit path including the fail-open ones, since an invocation that bailed
   * early is still an invocation. `recordFireLogEntry` swallows its own errors,
   * so this can never break a dispatch.
   */
  const overrideActive = isOverrideActive();
  /**
   * mt#3920 — `outcome` is clean-run evidence for guard-health's recovery join.
   *
   * Note this guard's override does NOT suppress the marker, unlike the merge gates'.
   * There the override exits before the check; here `decideBareProhibitionGate` still runs
   * and still writes its calibration record — the override only neutralizes enforcement.
   * The detection genuinely ran, so the record says so.
   */
  const finishRun: (decision: "allow" | "deny", outcome?: "decided" | "crashed") => never = (
    decision,
    outcome
  ) => {
    recordFireLogEntry({
      guardName: "bare-prohibition",
      event: "PreToolUse",
      decision,
      ...(outcome !== undefined ? { guardOutcome: outcome } : {}),
      durationMs: Date.now() - startedAt,
      toolName: input.tool_name,
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      ...(overrideActive
        ? {
            overrideEnvVar: OVERRIDE_ENV_VAR,
            overrideClassification: classifyOverride(OVERRIDE_ENV_VAR),
            overrideSource: "env" as const,
          }
        : {}),
    });
    process.exit(0);
  };

  let decision: BareProhibitionDecision;
  try {
    decision = decideBareProhibitionGate(input);
  } catch (err) {
    // Fail open on any detection error — a regex bug must never block every dispatch.
    process.stderr.write(
      `[warn-bare-prohibition-dispatch] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    // mt#3920: `crashed` — the detector threw and this allow is a fail-open.
    finishRun("allow", "crashed");
  }

  if (decision.report && decision.report.bare.length > 0) {
    appendCalibrationRecord(
      input.cwd,
      buildCalibrationRecord(input, decision.report, decision.enforcementEnabled)
    );
  }

  if (decision.decision === "allow") {
    finishRun("allow", "decided");
  }

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
  finishRun("deny", "decided");
}
