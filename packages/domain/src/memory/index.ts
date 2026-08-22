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
  MemorySearchResponse,
  MemoryListFilter,
  MemorySearchOptions,
} from "./types";

export { MEMORY_TYPES, MEMORY_SCOPES } from "./types";
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
