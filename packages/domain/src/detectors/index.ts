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

export type {
  DegradedReason,
  ExemplarSet,
  Nomination,
  NominationResult,
  NominationDeps,
  NominateOptions,
} from "./embedding-nomination";
export {
  nominate,
  cosineSimilarity,
  splitCandidateSegments,
  isSemanticProvider,
  DEFAULT_NOMINATION_TIMEOUT_MS,
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_CANDIDATE_SEGMENTS,
  MAX_SEGMENT_CHARS,
} from "./embedding-nomination";
export { resolveNominationDeps } from "./embedding-nomination-factory";

export type {
  SearchObservation,
  ClaimMatch,
  NegativeExistenceClaimInput,
  NegativeExistenceClaimResult,
} from "./negative-existence-claim";
export {
  detectNegativeExistenceClaim,
  extractNegativeExistenceClaims,
  extractCitedTaskIds,
  countSearchHits,
  isSearchCall,
  isThinSearch,
  NEGATIVE_EXISTENCE_PATTERNS,
  SEARCH_TOOL_NAMES,
  SEARCH_COMMAND_LEADERS,
} from "./negative-existence-claim";

export type {
  FlakinessClaim,
  // `FlakinessAttributionResult.claims` is typed as this, so a consumer reading
  // the result through the barrel needs to be able to name it here too.
  ResolvedFlakinessClaim,
  FlakinessAttributionResult,
} from "./flakiness-attribution";
export {
  detectFlakinessAttribution,
  extractFlakinessClaims,
  hasIsolationControl,
  hasLoadControl,
  hasUnverifiedMarkerNearClaim,
  FLAKINESS_ATTRIBUTION_PATTERNS,
  FLAKINESS_DENIAL_PATTERNS,
  LOAD_CONTROL_LABEL,
  UNVERIFIED_MARKER,
} from "./flakiness-attribution";

// mt#4374 — the first guard-decision extraction wave. Unlike the detectors
// above, these are lifted verdicts rather than new matchers: each one's hook
// module is now a thin binding that parses a payload and relays what these
// return.
export type { ToolDenialRule } from "./github-mcp-pr-write-denial";
export { checkToolDenial, toolDenials } from "./github-mcp-pr-write-denial";

export type { PrConvergenceReminderInput } from "./pr-convergence-reminder";
export {
  decidePrConvergenceReminder,
  DRIVE_TO_CONVERGENCE_REMINDER,
  PR_CREATE_TOOL_NAME,
} from "./pr-convergence-reminder";

export type {
  DispatchIntent,
  DispatchIntentDeclaration,
  DispatchIntentMatchContext,
  DispatchIntentGateDecision,
} from "./dispatch-intent-gate";
export {
  buildDispatchIntentDenialMessage,
  decideDispatchIntentGate,
  findLiveReadOnlyDeclaration,
  hasLiveDeclaration,
  isDeclarationValid,
  normalizeSessionId,
} from "./dispatch-intent-gate";

export type {
  NestedForkDispatchGateInput,
  NestedForkDispatchGateDecision,
} from "./nested-fork-dispatch-gate";
export {
  buildNestedForkDenialMessage,
  decideNestedForkDispatchGate,
  DENY_REASON_PREFIX,
  GATED_SUBAGENT_TYPE,
  OVERRIDE_ENV_VAR,
} from "./nested-fork-dispatch-gate";

export type {
  AbsenceClaim,
  ProbeObservation,
  CapabilityAbsenceInput,
  CapabilityAbsenceResult,
} from "./capability-absence-escalation";
export {
  detectCapabilityAbsenceEscalation,
  extractCapabilityAbsenceClaims,
  classifyProbeChannel,
  distinctProbeChannels,
  isOperatorRoutedAskResult,
  secondChannelFor,
  CAPABILITY_ABSENCE_PATTERNS,
  PROBE_CHANNEL_RULES,
  MIN_INDEPENDENT_CHANNELS,
  MAX_SUBJECT_CHARS,
} from "./capability-absence-escalation";
