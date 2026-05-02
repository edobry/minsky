/**
 * Ask subsystem — ADR-008 (mt#1034).
 *
 * Unified domain types, state machine, and repository for all human-in-the-loop
 * mechanisms in Minsky. Router lands in a separate task.
 */

export type {
  AgentId,
  AskKind,
  AskState,
  AskOption,
  ContextRef,
  AttentionCost,
  TransportKind,
  Ask,
} from "./types";

export { assertNever } from "./types";

// State machine
export {
  VALID_TRANSITIONS,
  guardTransition,
  isTerminal,
  InvalidAskTransitionError,
} from "./state-machine";

// Repository interface + implementations
export type { AskRepository, CreateAskInput, CloseAskInput, RespondAskInput } from "./repository";
export { DrizzleAskRepository, FakeAskRepository, ConcurrentTransitionError } from "./repository";

// Reconciler
export type {
  GithubReview,
  GithubReviewClient,
  ReconcileResult,
  AskReconcileOutcome,
} from "./reconciler";
export { reconcile, parsePrRef, findPrRef } from "./reconciler";

// Query helpers (render-time enrichment)
export { getOpenAskForTask, getOpenAsksByTaskIds } from "./queries";

// BLOCKED subtype derivation
export type { BlockedSubtype } from "./blocked-subtype";
export { deriveBlockedSubtype, formatBlockedStatus } from "./blocked-subtype";

// Service-window defaults (mt#1411 spine — mt#1488)
export type { ServiceWindowDefault } from "./service-window-defaults";
export { SERVICE_WINDOW_DEFAULTS, getServiceWindowDefault } from "./service-window-defaults";

// Attention window config + loader (mt#1489)
export type {
  AttentionWindowConfig,
  RawWindowEntry,
  RawAttentionConfig,
} from "./attention-windows/config";
export {
  rawWindowEntrySchema,
  rawAttentionConfigSchema,
  DEFAULT_ATTENTION_WINDOWS,
} from "./attention-windows/config";
export type {
  AttentionWindowsLoadResult,
  AttentionConfigValidationError,
  LoaderFs,
} from "./attention-windows/loader";
export {
  loadAttentionWindows,
  loadAttentionWindowsOrThrow,
  getAttentionConfigPath,
  realLoaderFs,
} from "./attention-windows/loader";
export type {
  WindowOpenedPayload,
  WindowClosedPayload,
  WindowClosedSummary,
  WindowNotifier,
} from "./attention-windows/notify";
export {
  createPostgresWindowNotifier,
  createNoopWindowNotifier,
  createRecordingWindowNotifier,
} from "./attention-windows/notify";
export { matchesCronNow, shouldWindowFireNow, nextCronFire } from "./attention-windows/cron";
