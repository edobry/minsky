/**
 * Memory domain module — public API surface.
 *
 * Exports types and the service. MCP/CLI commands are in mt#1007.
 */

export type {
  MemoryType,
  MemoryScope,
  MemoryRecord,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemorySearchResult,
  MemoryReadResult,
  MemorySearchResponse,
  MemoryListFilter,
  MemorySearchOptions,
} from "./types";

export { MEMORY_TYPES, MEMORY_SCOPES, DEFAULT_COLD_DAYS } from "./types";
export { l2DistanceToSimilarity, similarityToL2Distance } from "./similarity-score";
export { MemoryService, getMemoryRecordById, getMemoryRefSummary } from "./memory-service";
export type { MemoryServiceDeps, MemoryServiceDb, MemoryServiceSurface } from "./memory-service";
export { checkDerivation } from "./validation";
export type { DerivationIssue } from "./validation";

// Read-time staleness annotation (mt#1709).
export {
  computeStaleness,
  extractTrackingTaskRefs,
  renderStalenessNote,
  TRACKS_TASK_ASSOCIATION,
} from "./staleness";
export type {
  MemoryStaleness,
  StalenessOutcome,
  StalenessRefSource,
  CompletedTrackingTask,
} from "./staleness";
export { createTaskStatusLookup } from "./task-status-lookup";

// Measurement-decay annotation (mt#4452, trigger 2).
export {
  computeMeasurementDecay,
  extractCitedSubsystems,
  extractMeasurement,
  renderMeasurementNote,
} from "./measurement-decay";
export type { DetectedMeasurement, InterveningTask, MeasurementDecay } from "./measurement-decay";

// Trigger 3 (mt#4743). Added to the barrel by mt#4785: trigger 2 has been exported here since
// it shipped, trigger 3 never was, so the only consumer that could reach it was
// `memory-service.ts` via a relative import — which is why
// `scripts/verify-memory-staleness.ts` reported a rate for triggers 1 and 2 and none for 3.
export {
  assertedTaskIds,
  computeTaskStateDrift,
  extractTaskStateAssertions,
  renderTaskStateNote,
} from "./task-state-assertion";
export type { DriftedAssertion, TaskStateAssertion, TaskStateDrift } from "./task-state-assertion";
export { combineStaleness } from "./staleness";
export { createInterveningTaskLookup } from "./intervening-task-lookup";
