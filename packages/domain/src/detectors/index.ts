/**
 * Detector infrastructure — mt#1035 shared foundation.
 *
 * Re-exports all public types and implementations from the detector modules.
 * Downstream consumers (Surface 1, Surface 4, mt#503) import from this barrel.
 */

export type {
  Evidence,
  DetectionSignal,
  ToolCallContext,
  DiffContext,
  TranscriptContext,
  TrajectoryContext,
  DetectionContext,
  Detector,
  AskIntent,
  AskOption,
  ContextRef,
} from "./types";

export { signalToAskIntent } from "./router-bridge";

export type { DismissalRecord, DismissalInsert, AnyDismissalStore } from "./dismissal-store";
export { DismissalStore, InMemoryDismissalStore, detectorDismissalsTable } from "./dismissal-store";

export type { Severity, DismissalStats, SeverityOptions } from "./severity-downgrade";
export { computeEffectiveSeverity, DEFAULT_DOWNGRADE_THRESHOLD } from "./severity-downgrade";
