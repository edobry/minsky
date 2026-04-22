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
export { MemoryService } from "./memory-service";
export type { MemoryServiceDeps, MemoryServiceDb, MemoryServiceSurface } from "./memory-service";
export { checkDerivation } from "./validation";
export type { DerivationIssue } from "./validation";
