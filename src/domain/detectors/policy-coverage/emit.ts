/**
 * Ask emission wiring — Surface 1 of the System 3* detector.
 *
 * Builds a `DetectionSignal` from an uncovered action and converts it to an
 * `AskIntent` via the shared router-bridge from mt#1574. Also produces the
 * deterministic evidence signature used for dismissal lookup.
 *
 * The hook entry point composes:
 *   action-filter → corpus-loader → coverage → emit
 *
 * If `decideCoverage` returns `{ covered: false }`, this module:
 *   1. Builds the `DetectionSignal` (severity, summary, evidence, options).
 *   2. Computes the dismissal-store signature for the action.
 *   3. Provides a helper to convert the signal to an `AskIntent` via
 *      `signalToAskIntent` from mt#1574.
 *
 * The hook is responsible for actually consulting the dismissal store and
 * either short-circuiting (dismissed) or surfacing the Ask via
 * `permissionDecision = "deny"` with the question in the reason.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Integration with the Ask router
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Detection
 */

import { createHash } from "node:crypto";
import type { FilterReason } from "./action-filter";
import type { ActionDescriptor } from "./coverage";
import type { DetectionSignal, DetectionContext, AskIntent, Evidence } from "../types";
import { signalToAskIntent } from "../router-bridge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable identifier for this detector. */
export const DETECTOR_ID = "policy-coverage";

/** Versioned ruleset for dismissal scoping. Bump when category/authority lists change. */
export const DETECTOR_VERSION = "v0.1.0";

/**
 * Per-reason base severity. Higher-severity reasons are more likely to be
 * unasked directions (e.g. a new dependency is preference-bound by definition,
 * while a new file is borderline — sometimes routine scaffolding).
 *
 * The router may downgrade these via `computeEffectiveSeverity` from mt#1574
 * when the dismissal rate exceeds the threshold.
 */
const SEVERITY_BY_REASON: Record<FilterReason, "low" | "medium" | "high"> = {
  "new-file": "low",
  "new-dependency": "high",
  "new-config-key": "high",
  "new-user-facing-string": "medium",
  "new-top-level-export": "medium",
};

/**
 * Per-reason summary template. Used for the `DetectionSignal.summary` and
 * the resulting Ask `title`. Kept short — the question body carries detail.
 */
const SUMMARY_TEMPLATE: Record<FilterReason, string> = {
  "new-file": "Creating a new file",
  "new-dependency": "Adding a new dependency",
  "new-config-key": "Introducing a new config default",
  "new-user-facing-string": "Adding a new user-facing string",
  "new-top-level-export": "Introducing a new top-level export",
};

// ---------------------------------------------------------------------------
// Evidence signature
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic signature for an action.
 *
 * The signature is used as the lookup key for the dismissal store. Two
 * actions with the same `(reason, normalizedFilePath)` tuple produce the
 * same signature, so a dismissal of one suppresses re-fires on the other.
 *
 * Normalization: file paths are stripped to their basename + extension to
 * ignore directory churn (e.g. moving a file under a subdir doesn't reset
 * dismissals).
 */
export function buildEvidenceSignature(action: ActionDescriptor): string {
  const normalizedPath = action.filePath ? extractPathSignature(action.filePath) : "no-path";
  const payload = `${DETECTOR_ID}@${DETECTOR_VERSION}|${action.reason}|${normalizedPath}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Extract the signature-relevant portion of a file path.
 *
 * Returns the basename + extension. This treats moves as the same action.
 * Special directories (`tests`, `__tests__`, `migrations`, `scripts`) are
 * kept as a prefix so test/migration actions don't collide with their
 * production counterparts.
 *
 * Path-separator handling: splits on BOTH forward-slash and backslash so
 * dismissal stability holds across POSIX, Windows, and mixed-separator
 * inputs (e.g. tool callers that pass an os-specific path through). The
 * specific test that caught this in PR #951 R1: a basename moved from
 * `src/foo.ts` to `src\\foo.ts` would have produced different signatures
 * under the previous `'/'-only split, defeating the "moves collapse"
 * guarantee.
 */
function extractPathSignature(filePath: string): string {
  // Split on either separator; filter empties for leading/trailing slashes.
  const segments = filePath.split(/[/\\]/).filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? filePath;

  const specialDirs = ["tests", "__tests__", "migrations", "scripts"];
  const prefix = segments.find((s) => specialDirs.includes(s));

  return prefix ? `${prefix}:${basename}` : basename;
}

// ---------------------------------------------------------------------------
// Detection signal builder
// ---------------------------------------------------------------------------

/**
 * Build a `DetectionSignal` for an uncovered action.
 *
 * The signal carries:
 *   - kind = "direction.decide" (preference-bound)
 *   - severity from the per-reason table
 *   - summary from the per-reason template
 *   - evidence pointing to the tool call and the policy gap
 *   - suggestedQuestion phrased for operator response
 *   - suggestedOptions for the standard "approve / dismiss / refer" frame
 *
 * Per mt#1035 §Detector interface.
 */
export function buildDetectionSignal(
  action: ActionDescriptor,
  toolName: string,
  toolParams: Record<string, unknown>
): DetectionSignal {
  const severity = SEVERITY_BY_REASON[action.reason];
  const summary = SUMMARY_TEMPLATE[action.reason];

  const evidence: Evidence[] = [
    {
      kind: "tool-call",
      payload: { toolName, params: toolParams },
    },
    {
      kind: "policy-gap",
      payload: {
        reason: action.reason,
        detail: action.detail,
        filePath: action.filePath,
      },
    },
  ];

  const target = action.filePath ?? "(unknown target)";
  const suggestedQuestion = formatQuestion(action, target);

  return {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    suspectedKind: "direction.decide",
    severity,
    summary: `${summary}: ${target}`,
    evidence,
    suggestedQuestion,
    suggestedOptions: [
      {
        label: "Approve once",
        value: { action: "approve", scope: "this-call" },
        description: "Allow this specific tool call to proceed.",
      },
      {
        label: "Dismiss this signature",
        value: { action: "dismiss", signature: buildEvidenceSignature(action) },
        description:
          "Allow now and silence future detections matching the same (reason, path) signature.",
      },
      {
        label: "Refer to policy",
        value: { action: "refer", target: "policy" },
        description: "Block this call and request a policy update before proceeding.",
      },
    ],
    contextRefs: action.filePath
      ? [{ kind: "file", ref: action.filePath, description: action.detail }]
      : [],
  };
}

/**
 * Format the question text shown to the operator.
 *
 * Avoids generic phrasing — the question names the specific reason and target
 * so the operator can decide without expanding evidence.
 */
function formatQuestion(action: ActionDescriptor, target: string): string {
  switch (action.reason) {
    case "new-file":
      return `About to create a new file at ${target}. Is this directory layout decision authorized?`;
    case "new-dependency":
      return `About to introduce a new dependency in ${target}. Is the choice of library / package authorized?`;
    case "new-config-key":
      return `About to introduce a new config default in ${target}. Is the chosen value authorized?`;
    case "new-user-facing-string":
      return `About to add a user-facing string in ${target}. Is the chosen wording authorized?`;
    case "new-top-level-export":
      return `About to introduce a new top-level export in ${target}. Is the chosen name / abstraction authorized?`;
  }
}

// ---------------------------------------------------------------------------
// AskIntent emission (delegates to mt#1574 router-bridge)
// ---------------------------------------------------------------------------

/**
 * Convert a `DetectionSignal` to an `AskIntent` for submission to the Ask
 * router (mt#1069). Thin wrapper around `signalToAskIntent` from mt#1574 —
 * present here so the hook layer has a single import surface for emission.
 */
export function emitAskIntent(signal: DetectionSignal, ctx: DetectionContext): AskIntent {
  return signalToAskIntent(signal, ctx);
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __TEST_ONLY = {
  SEVERITY_BY_REASON,
  SUMMARY_TEMPLATE,
  extractPathSignature,
  formatQuestion,
} as const;
