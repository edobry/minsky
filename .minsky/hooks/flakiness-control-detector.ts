#!/usr/bin/env bun
// PreToolUse detector: a `tasks_create` spec that claims a failure MODE —
// "it's flaky", or the denial "it fails deterministically" — while recording
// neither the isolation control nor an `UNVERIFIED` marker (mt#3658).
//
// CALIBRATION-FIRST: `INJECTION_ENABLED = false`. The hook writes a calibration
// record and nothing else; it does NOT block `tasks_create` and does not inject.
// Flipping it is the graduation decision the calibration data exists to inform
// (mt#2263 ladder), and it needs an operator disposition via
// `/calibration-review` — not a maintainer's judgement here.
//
// WHY IT IS NOT DENY-TIER LIKE ITS NEIGHBOUR. `require-duplicate-check-record`
// ships denying on this same surface, and its own rationale says why the two
// differ: a literal-form presence check has no recall/precision axes, so there
// is nothing to calibrate. This one matches PROSE VOCABULARY — "intermittent",
// "not load-dependent" — which has both axes and a real paraphrase frontier, so
// it is exactly the population ADR-024's ladder governs.
//
// The matcher lives in `packages/domain/src/detectors/flakiness-attribution.ts`
// per ADR-024's Decision clause (one shared framework, not divergent regex
// copies), following the mt#3918 precedent. This file is the thin adapter.
//
// REGISTRATION NOTES (kept here rather than in `registry.ts`, which sits at its
// 1500-line ceiling — and where guard-feedback-authoring says maintainer-facing
// rationale belongs anyway):
//
// - `tuningOwnership: "advisory"` — the vocabulary match has recall/precision
//   axes the calibration log exists to size. Its neighbour's `invariant` is
//   right for a presence check and wrong for this.
// - `timeoutMs: 5000` — pure string work on the tool payload, no database, no
//   filesystem, no transcript. Matches the deny-tier neighbour on this surface.
// - `attentionCost.denialMessageSizeChars: 1000` — MEASURED via `renderProbe`,
//   with both axes saturated at once: MAX_RENDERED_CLAIMS claims plus the
//   `...and N more` line, each phrase at the matcher's 120-char cap, and the
//   DENIAL branch (the longer directive). A proved ceiling rather than a
//   sample, because the only otherwise-unbounded input — phrase length — is
//   bounded by the matcher itself.
// - The canary asserts `calibration`, not `additionalContext`, so flipping
//   `INJECTION_ENABLED` later gains an outcome rather than breaking the canary.
//
// Fail-open: any error allows the call. Override: MINSKY_SKIP_FLAKINESS_CONTROL=1.
//
// @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — D1/D2
// @see .claude/skills/create-task/SKILL.md — §2b, the authoring-side requirement

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import {
  detectFlakinessAttribution,
  type FlakinessAttributionResult,
} from "@minsky/domain/detectors/flakiness-attribution";

/** Override env var: set to "1"/"true"/"yes" to skip the check. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_FLAKINESS_CONTROL";

/**
 * Calibration-first (mt#2263 ladder). While false, `run` returns a calibration
 * record and no `additionalContext`, so the guard is measurable without
 * spending any agent attention. `renderWorstCase` still renders the injection
 * text so the size ceiling is enforced against something real (mt#4002) —
 * delete the probe when this flips.
 */
export const INJECTION_ENABLED = false;

/** Claims enumerated in the advisory before it collapses to a count. */
const MAX_RENDERED_CLAIMS = 3;

/** Longest excerpt kept per claim in a record. */
const MAX_EXCERPT_CHARS = 240;

function isOverridden(): string | undefined {
  const value = process.env[OVERRIDE_ENV_VAR];
  if (value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes") {
    return value;
  }
  return undefined;
}

/**
 * The advisory, per `guard-feedback-authoring.mdc`: guard-id header, the quoted
 * phrases that tripped it, one imperative directive, and the branch under which
 * NOT running the control is correct.
 *
 * The directive differs by family because the remedy does. An ATTRIBUTION is
 * usually answered by running the file alone; a DENIAL is answered by running
 * the control that would falsify the denial — the same command, but the agent
 * has to be told it is testing its own confident verdict, which is the shape
 * that reads as already-investigated (mt#3719).
 */
export function buildAdvisory(result: FlakinessAttributionResult): string {
  const shown = result.claims.slice(0, MAX_RENDERED_CLAIMS);
  const overflow = result.claims.length - shown.length;
  const hasDenial = result.claims.some((c) => c.family === "denial");

  const lines = [
    "[flakiness-control] This spec claims a failure MODE with no isolation control recorded.",
    "",
    ...shown.map((c) => `  - ${c.family}: "${c.phrase}"`),
    ...(overflow > 0 ? [`  ... and ${overflow} more`] : []),
    "",
    hasDenial
      ? "Run the control that would FALSIFY the denial — the file alone, then its directory — and record the command with its observed pass/fail counts. A denial reads as the already-investigated verdict, which is why it is the shape that most needs the check."
      : "Run the file alone and record the command with its observed pass/fail counts. A control that FAILS in isolation is the useful outcome: it means a real defect wearing a timing costume.",
    "",
    "If it genuinely cannot be run now, mark the attribution with the literal UNVERIFIED beside it rather than leaving the claim unqualified.",
  ];

  return lines.join("\n");
}

/**
 * Worst case: the claim list at its render cap AND the longer of the two
 * directive branches (the denial branch) AND the overflow line — saturated on
 * every axis at once, per `guard-feedback-authoring.mdc`.
 *
 * The claim axis IS capped at {@link MAX_RENDERED_CLAIMS} with an `…and N more`
 * line, so this is a proved ceiling rather than a sample. The only unbounded
 * input is a single phrase's length, and the matcher caps that at 120 chars.
 */
export function renderWorstCase(): string {
  const longestPhrase = "x".repeat(120);
  const claims = Array.from({ length: MAX_RENDERED_CLAIMS + 2 }, (_, i) => ({
    phrase: longestPhrase,
    excerpt: "",
    family: (i === 0 ? "denial" : "attribution") as "denial" | "attribution",
    index: 0,
  }));

  return buildAdvisory({
    matched: true,
    claims,
    hasIsolationControl: false,
    hasUnverifiedMarker: false,
    singleFileAcceptanceTestSuspected: true,
  });
}

/** Dispatcher entry point (ADR-028 D1/D2). Returns null for silent allow. */
export function run(input: ToolHookInput, _ctx: DispatchContext): GuardOutcome | null {
  const override = isOverridden();
  if (override) {
    return {
      auditLines: [
        `[flakiness-control-detector] OVERRIDE: ack=${override} session=${
          input.session_id ?? "unknown"
        } ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const spec = input.tool_input?.["spec"];
  if (typeof spec !== "string" || spec.trim() === "") return null;

  const result = detectFlakinessAttribution(spec);
  if (!result.matched) return null;

  // The calibration record is RETURNED, not written here — the dispatcher owns
  // that write via `calibrationLog` on the registration, and writing from both
  // places would double-count every fire, which is what makes a rate
  // un-measurable.
  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      claims: result.claims.map((c) => ({
        phrase: c.phrase,
        family: c.family,
        excerpt: c.excerpt.slice(0, MAX_EXCERPT_CHARS),
      })),
      // Both evidence shapes, so a false-positive review can tell "no evidence
      // at all" from "evidence present but not where the check looked" — the
      // latter is a matcher bug, the former is a true positive.
      hasIsolationControl: result.hasIsolationControl,
      hasUnverifiedMarker: result.hasUnverifiedMarker,
      singleFileAcceptanceTestSuspected: result.singleFileAcceptanceTestSuspected,
      specLength: spec.length,
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildAdvisory(result);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const input = await readInput<ToolHookInput>();
    const outcome = run(input, {} as DispatchContext);
    // STDERR only. ADR-028 D1 reserves a PreToolUse hook's stdout for the single
    // JSON object, and mt#3625 measured that anything else there makes Claude
    // Code discard the hook's ENTIRE output — including a different guard's deny.
    if (outcome?.auditLines) {
      for (const line of outcome.auditLines) process.stderr.write(line);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[flakiness-control-detector] fail-open: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    process.exit(0);
  }
}
