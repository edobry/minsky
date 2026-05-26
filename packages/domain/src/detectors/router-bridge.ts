/**
 * Router bridge — converts a `DetectionSignal` to an `AskIntent`.
 *
 * This is the boundary between the detector layer and the Ask router. Every
 * detection signal flows through here before being submitted to the router.
 * The bridge ensures `metadata.detectorId`, `metadata.severity`, and
 * `metadata.evidence` are always populated per mt#1035 §Integration with the
 * Ask router.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Integration with the Ask router
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Detection
 */

import type { DetectionSignal, DetectionContext, AskIntent } from "./types";

/**
 * Convert a `DetectionSignal` produced by a detector into an `AskIntent` for
 * submission to the Ask router.
 *
 * Field mapping:
 *   signal.suspectedKind      → intent.kind
 *   detectorId@version         → intent.classifierVersion
 *   ctx.agentId               → intent.requestor
 *   signal.summary            → intent.title
 *   signal.suggestedQuestion  → intent.question  (falls back to signal.summary)
 *   signal.suggestedOptions   → intent.options
 *   signal.contextRefs        → intent.contextRefs
 *   ctx.parentTaskId          → intent.parentTaskId
 *   ctx.sessionId             → intent.parentSessionId
 *   signal.detectorId         → intent.metadata.detectorId
 *   signal.severity           → intent.metadata.severity
 *   signal.evidence           → intent.metadata.evidence
 *
 * Per mt#1035 §Integration with the Ask router.
 */
export function signalToAskIntent(signal: DetectionSignal, ctx: DetectionContext): AskIntent {
  return {
    kind: signal.suspectedKind,
    classifierVersion: `${signal.detectorId}@${signal.detectorVersion}`,
    requestor: ctx.agentId,
    title: signal.summary,
    question: signal.suggestedQuestion ?? signal.summary,
    options: signal.suggestedOptions,
    contextRefs: signal.contextRefs,
    parentTaskId: ctx.parentTaskId,
    parentSessionId: ctx.sessionId,
    metadata: {
      detectorId: signal.detectorId,
      severity: signal.severity,
      evidence: signal.evidence,
    },
  };
}
