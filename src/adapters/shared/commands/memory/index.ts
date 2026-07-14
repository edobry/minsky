/**
 * Memory Commands
 *
 * Commands for creating, searching, listing, updating, deleting, and
 * superseding memory records.  Registers 8 commands in the shared command
 * registry under the MEMORY category:
 *   - memory.search    — semantic search over memory records
 *   - memory.get       — fetch a single memory by id
 *   - memory.list      — browse memories with optional filters
 *   - memory.create    — create a new memory (with derivation-discipline check)
 *   - memory.update    — update fields on an existing memory
 *   - memory.delete    — delete a memory by id
 *   - memory.similar   — find memories similar to an existing one
 *   - memory.supersede — atomically replace an existing memory
 *   - memory.lineage   — trace a memory's supersession chain
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type CommandDefinition,
} from "../../command-registry";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { EmbeddingService } from "@minsky/domain/ai/embeddings/types";
import type { VectorStorage } from "@minsky/domain/storage/vector/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import type {
  MemoryType,
  MemoryScope,
  MemoryRecord,
  MemoryCreateInput,
  MemorySearchResult,
} from "@minsky/domain/memory/types";
import { MEMORY_TYPES, MEMORY_SCOPES } from "@minsky/domain/memory/types";
import { checkDerivation } from "@minsky/domain/memory/validation";
import { emitSystemEventBestEffort } from "../system-event-emit";
import { memoriesTable } from "@minsky/domain/storage/schemas/memory-embeddings";
import { classifyIdInput, resolveIdPrefixOrThrow } from "@minsky/domain/utils/id-prefix-resolver";

// ─── Zod enum helpers ────────────────────────────────────────────────────────

const memoryTypeValues = Object.values(MEMORY_TYPES) as [MemoryType, ...MemoryType[]];
const memoryScopeValues = Object.values(MEMORY_SCOPES) as [MemoryScope, ...MemoryScope[]];

// ─── Parameter definitions (Zod schemas) ─────────────────────────────────────

const memorySearchParams = {
  query: {
    schema: z.string(),
    description: "Semantic search query",
    required: true as const,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return (default 10)",
    required: false as const,
    defaultValue: 10,
  },
  type: {
    schema: z.enum(memoryTypeValues),
    description: "Filter by memory type",
    required: false as const,
  },
  scope: {
    schema: z.enum(memoryScopeValues),
    description: "Filter by memory scope",
    required: false as const,
  },
  projectId: {
    schema: z.string(),
    description: "Filter by project identifier",
    required: false as const,
  },
  excludeSuperseded: {
    schema: z.boolean(),
    description: "When true, exclude superseded memories from results",
    required: false as const,
    defaultValue: false,
  },
  allProjects: {
    schema: z.boolean().optional(),
    description:
      "Return memories from all projects (disable project-scope filtering; ADR-021, mt#2416)",
    required: false as const,
  },
} satisfies CommandParameterMap;

const memoryGetParams = {
  id: {
    schema: z.string(),
    description: "Memory record identifier",
    required: true as const,
  },
} satisfies CommandParameterMap;

const memoryListParams = {
  type: {
    schema: z.enum(memoryTypeValues),
    description: "Filter by memory type",
    required: false as const,
  },
  scope: {
    schema: z.enum(memoryScopeValues),
    description: "Filter by memory scope",
    required: false as const,
  },
  projectId: {
    schema: z.string(),
    description: "Filter by project identifier",
    required: false as const,
  },
  excludeSuperseded: {
    schema: z.boolean(),
    description: "When true, exclude superseded memories",
    required: false as const,
    defaultValue: false,
  },
  stale: {
    schema: z.boolean(),
    description:
      "When true, filter to memories never accessed or older than the staleness threshold",
    required: false as const,
    defaultValue: false,
  },
  stalenessDays: {
    schema: z.number().int().positive(),
    description: "Threshold (in days) for the --stale filter; defaults to 90",
    required: false as const,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return",
    required: false as const,
  },
  associationType: {
    schema: z.string(),
    description:
      "Filter by association type (e.g., 'tracksTask'). Must be used together with associationTarget.",
    required: false as const,
  },
  associationTarget: {
    schema: z.string(),
    description:
      "Filter by association target ID (e.g., 'mt#2053'). Must be used together with associationType.",
    required: false as const,
  },
  allProjects: {
    schema: z.boolean().optional(),
    description:
      "Return memories from all projects (disable project-scope filtering; ADR-021, mt#2416)",
    required: false as const,
  },
} satisfies CommandParameterMap;

const memoryLineageParams = {
  id: {
    schema: z.string(),
    description: "Memory record identifier to trace lineage for",
    required: true as const,
  },
} satisfies CommandParameterMap;

const memoryCreateParams = {
  type: {
    schema: z.enum(memoryTypeValues),
    description: "Memory type",
    required: true as const,
  },
  name: {
    schema: z.string(),
    description: "Short name / title for the memory",
    required: true as const,
  },
  description: {
    schema: z.string(),
    description: "Longer description of the memory",
    required: true as const,
  },
  content: {
    schema: z.string(),
    description: "Full content of the memory",
    required: true as const,
  },
  scope: {
    schema: z.enum(memoryScopeValues),
    description:
      'Scope of the memory (project | user | cross_project). Defaults to "project" when omitted (mt#2663).',
    required: false as const,
    defaultValue: MEMORY_SCOPES.project,
  },
  projectId: {
    schema: z.string().nullable(),
    description: "Project identifier (required when scope=project)",
    required: false as const,
  },
  tags: {
    schema: z.array(z.string()),
    description: "Optional tags for categorisation",
    required: false as const,
  },
  sourceAgentId: {
    schema: z.string().nullable(),
    description: "Agent that produced this memory",
    required: false as const,
  },
  sourceSessionId: {
    schema: z.string().nullable(),
    description: "Session that produced this memory",
    required: false as const,
  },
  confidence: {
    schema: z.number().nullable(),
    description: "Confidence score (0–1), reserved for Phase 3",
    required: false as const,
  },
  associations: {
    schema: z.record(z.string(), z.array(z.string())),
    description:
      'Structured entity associations (e.g., { tracksTask: ["mt#2053"] }). See ADR-012 for type-string conventions.',
    required: false as const,
  },
  force: {
    schema: z.boolean(),
    description: "Bypass the derivation-discipline validator",
    required: false as const,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

const memoryUpdateParams = {
  id: {
    schema: z.string(),
    description: "Memory record identifier to update",
    required: true as const,
  },
  type: {
    schema: z.enum(memoryTypeValues),
    description: "New memory type",
    required: false as const,
  },
  name: {
    schema: z.string(),
    description: "New name / title",
    required: false as const,
  },
  description: {
    schema: z.string(),
    description: "New description",
    required: false as const,
  },
  content: {
    schema: z.string(),
    description: "New content",
    required: false as const,
  },
  scope: {
    schema: z.enum(memoryScopeValues),
    description: "New scope",
    required: false as const,
  },
  projectId: {
    schema: z.string().nullable(),
    description: "New project identifier",
    required: false as const,
  },
  tags: {
    schema: z.array(z.string()),
    description: "New tags",
    required: false as const,
  },
  sourceAgentId: {
    schema: z.string().nullable(),
    description: "New source agent identifier",
    required: false as const,
  },
  sourceSessionId: {
    schema: z.string().nullable(),
    description: "New source session identifier",
    required: false as const,
  },
  confidence: {
    schema: z.number().nullable(),
    description: "New confidence score",
    required: false as const,
  },
  associations: {
    schema: z.record(z.string(), z.array(z.string())),
    description:
      "Merge associations: new keys added, existing keys replaced, keys set to [] removed.",
    required: false as const,
  },
} satisfies CommandParameterMap;

const memoryDeleteParams = {
  id: {
    schema: z.string(),
    description: "Memory record identifier to delete",
    required: true as const,
  },
} satisfies CommandParameterMap;

const memorySimilarParams = {
  id: {
    schema: z.string(),
    description: "ID of the source memory to find neighbours for",
    required: true as const,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of similar memories to return (default 10)",
    required: false as const,
    defaultValue: 10,
  },
  threshold: {
    schema: z.number(),
    description: "Minimum similarity score threshold",
    required: false as const,
  },
} satisfies CommandParameterMap;

const memorySupersededParams = {
  oldId: {
    schema: z.string(),
    description: "ID of the memory to supersede",
    required: true as const,
  },
  // newInput fields — flattened
  type: {
    schema: z.enum(memoryTypeValues),
    description: "Memory type for the replacement",
    required: true as const,
  },
  name: {
    schema: z.string(),
    description: "Name for the replacement memory",
    required: true as const,
  },
  description: {
    schema: z.string(),
    description: "Description for the replacement memory",
    required: true as const,
  },
  content: {
    schema: z.string(),
    description: "Content for the replacement memory",
    required: true as const,
  },
  scope: {
    schema: z.enum(memoryScopeValues),
    description: "Scope for the replacement memory",
    required: true as const,
  },
  projectId: {
    schema: z.string().nullable(),
    description: "Project identifier for the replacement",
    required: false as const,
  },
  tags: {
    schema: z.array(z.string()),
    description: "Tags for the replacement memory",
    required: false as const,
  },
  sourceAgentId: {
    schema: z.string().nullable(),
    description: "Source agent for the replacement",
    required: false as const,
  },
  sourceSessionId: {
    schema: z.string().nullable(),
    description: "Source session for the replacement",
    required: false as const,
  },
  confidence: {
    schema: z.number().nullable(),
    description: "Confidence score for the replacement",
    required: false as const,
  },
  reason: {
    schema: z.string(),
    description: "Reason the old memory is being superseded",
    required: false as const,
  },
} satisfies CommandParameterMap;

// ─── Injectable dependencies (for testing) ────────────────────────────────────

export interface MemoryCommandsDeps {
  /** Override for creating a MemoryService (skips real DB/embedding setup) */
  createMemoryService?: (deps: {
    db: MemoryServiceDb;
    vectorStorage: VectorStorage;
    embeddingService: EmbeddingService;
  }) => MemoryServiceSurface;
  /** Pre-built MemoryService instance (highest precedence) */
  memoryService?: MemoryServiceSurface;
}

// ─── Internal service factory ─────────────────────────────────────────────────

async function resolveMemoryService(
  deps: MemoryCommandsDeps | undefined,
  ctx: CommandExecutionContext
): Promise<MemoryServiceSurface> {
  // Highest precedence: pre-built instance (test injection path)
  if (deps?.memoryService) {
    return deps.memoryService;
  }

  // Mid precedence: factory function (test injection path)
  if (deps?.createMemoryService) {
    // Provide minimal no-op stubs so factory can be called from tests
    const { MemoryVectorStorage } = await import(
      "@minsky/domain/storage/vector/memory-vector-storage"
    );
    const noopEmbedding: EmbeddingService = {
      generateEmbedding: async () => [],
      generateEmbeddings: async () => [],
    };
    const noopVectorStorage = new MemoryVectorStorage(1);
    // Provide a minimal no-op DB (factory may ignore it in tests)
    const noopDb: MemoryServiceDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: async () => {} }),
      transaction: async (fn) => fn(noopDb),
    };
    return deps.createMemoryService({
      db: noopDb,
      vectorStorage: noopVectorStorage,
      embeddingService: noopEmbedding,
    });
  }

  // Real path: resolve from DI container or construct from config
  const persistence = ctx?.container?.has("persistence")
    ? ctx.container.get("persistence")
    : undefined;

  const { createEmbeddingServiceFromConfig } = await import(
    "@minsky/domain/ai/embedding-service-factory"
  );
  const embeddingService = await createEmbeddingServiceFromConfig();

  let vectorStorage: VectorStorage;
  if (persistence) {
    const { createVectorStorageForDomain } = await import(
      "@minsky/domain/storage/vector/vector-storage-factory"
    );
    vectorStorage = await createVectorStorageForDomain("memory", 1536, persistence);
  } else {
    log.warn("[memory] No persistence provider; using in-memory vector storage");
    const { MemoryVectorStorage } = await import(
      "@minsky/domain/storage/vector/memory-vector-storage"
    );
    vectorStorage = new MemoryVectorStorage(1536);
  }

  // DB: resolve via the SQL-capable persistence provider contract.
  // Memory requires a Postgres-backed db for the memories table — fail loudly
  // if we have no persistence provider or it lacks the SQL capability.
  if (!persistence) {
    throw new Error(
      "Memory service requires a persistence provider (none available via DI container). " +
        "This command requires a running Minsky server with Postgres configured."
    );
  }

  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  if (!(persistence instanceof PersistenceProvider)) {
    throw new Error(
      "Memory service requires a PersistenceProvider instance; got incompatible DI binding."
    );
  }

  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error(
      "Memory service requires a SQL-capable persistence provider (Postgres). " +
        `Got provider with capabilities: ${JSON.stringify(persistence.capabilities)}`
    );
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error(
      "Memory service requires an initialized Postgres database connection; got null."
    );
  }

  const db = connection as MemoryServiceDb;

  const { MemoryService: MemoryServiceClass } = await import("@minsky/domain/memory");
  return new MemoryServiceClass({ db, vectorStorage, embeddingService });
}

// ─── ADR-021 project scope resolution ────────────────────────────────────────

/**
 * Resolve the current project scope for memory queries (ADR-021, mt#2416).
 *
 * Returns a project UUID string when this workspace maps to a known project,
 * or undefined when allProjects=true, no persistence is available, the project
 * is unidentified, or resolution fails (fail-open: never throws).
 */
async function resolveMemoryProjectScope(
  allProjects: boolean | undefined,
  ctx: CommandExecutionContext
): Promise<string | undefined> {
  if (allProjects) return undefined;

  const persistence = ctx?.container?.has("persistence")
    ? ctx.container.get("persistence")
    : undefined;
  if (!persistence) return undefined;

  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  if (!(persistence instanceof PersistenceProvider)) return undefined;
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    return undefined;
  }

  try {
    const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
    const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
    const { isAllProjects } = await import("@minsky/domain/project/scope");
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return undefined;
    const rawDb = await persistence.getDatabaseConnection();
    if (!rawDb) return undefined;
    const { type: _t, ...db } =
      rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb &
        Record<string, unknown>;
    const scope = await resolveProjectScope(
      identity,
      db as import("@minsky/domain/project/scope-resolver").ScopeResolverDb
    );
    return isAllProjects(scope) ? undefined : scope;
  } catch (err: unknown) {
    log.debug("[memory] Project scope resolution failed; defaulting to all projects", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ─── mt#2696: id-prefix resolution ────────────────────────────────────────────

/**
 * Resolve the raw Postgres connection for a prefix-resolution lookup, without
 * building a full MemoryService. Fails soft (returns null) on any resolution
 * problem — the caller falls back to passing the raw input through, letting
 * `resolveMemoryService` (called immediately after in every command) surface
 * its own descriptive "persistence provider required" error.
 */
async function resolveMemoryDbForPrefix(
  ctx: CommandExecutionContext
): Promise<MemoryServiceDb | null> {
  const persistence = ctx?.container?.has("persistence")
    ? ctx.container.get("persistence")
    : undefined;
  if (!persistence) return null;

  try {
    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }
    const connection = await persistence.getDatabaseConnection();
    return connection ? (connection as MemoryServiceDb) : null;
  } catch (err: unknown) {
    log.debug("[memory] DB resolution for id-prefix lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve a caller-supplied memory id (full UUID or unambiguous prefix, mt#2696)
 * to the full UUID `memories.id` before it reaches any `eq(memoriesTable.id, ...)`
 * comparison. A full UUID passes through unchanged with no query. A short/no-match/
 * ambiguous prefix throws a clean tool-level error (never a raw Postgres
 * "invalid input syntax for type uuid" error).
 *
 * When no DB connection is resolvable here, the raw input is passed through —
 * the immediately-following `resolveMemoryService` call in every command
 * surfaces the "persistence provider required" error instead.
 */
async function resolveMemoryIdInput(id: string, ctx: CommandExecutionContext): Promise<string> {
  const db = await resolveMemoryDbForPrefix(ctx);
  if (!db) return id;

  return resolveIdPrefixOrThrow({
    db,
    table: memoriesTable,
    idColumn: memoriesTable.id,
    labelColumn: memoriesTable.name,
    input: id,
    entityName: "memory",
  });
}

// ─── Registration function ────────────────────────────────────────────────────

export function registerMemoryCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  } = sharedCommandRegistry,
  deps?: MemoryCommandsDeps
): void {
  // ── memory.search ─────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.search",
    category: CommandCategory.MEMORY,
    name: "search",
    description:
      "Semantic search over memory records. Returns ranked results with similarity scores.",
    parameters: memorySearchParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.search", { query: params.query, limit: params.limit });

      const service = await resolveMemoryService(deps, ctx ?? {});

      // ADR-021 / mt#2416: resolve project scope for this query.
      const projectScope = await resolveMemoryProjectScope(params.allProjects, ctx ?? {});

      try {
        const response = await service.search(params.query, {
          limit: params.limit ?? 10,
          filter: {
            type: params.type,
            scope: params.scope,
            projectId: params.projectId,
            projectScope,
            excludeSuperseded: params.excludeSuperseded,
          },
        });

        return response;
      } catch (error) {
        log.error("[memory.search] Search failed", { error: getErrorMessage(error) });
        return { results: [], backend: "none" as const, degraded: true };
      }
    },
  });

  // ── memory.get ────────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.get",
    category: CommandCategory.MEMORY,
    name: "get",
    description:
      "Fetch a single memory record by its identifier. Accepts a full UUID or an " +
      "unambiguous prefix (>=8 hex chars, mt#2696) — e.g. an id cited in a handoff.",
    parameters: memoryGetParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.get", { id: params.id });

      // mt#2696: resolve a short-prefix citation to the full uuid before it
      // ever reaches a Postgres `uuid` column comparison.
      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});
      const record = await service.get(id);

      if (!record) {
        // mt#2696 R1: name both what the caller passed AND how it was
        // interpreted (full UUID vs prefix) rather than echoing the raw
        // input unconditionally — a resolved prefix that no longer matches
        // a live row (e.g. deleted between resolution and this read) reads
        // very differently from a syntactically full UUID that never
        // existed, and the diagnostic should say which happened.
        const classification = classifyIdInput(params.id);
        // Only claim a resolution happened when one actually did — when no DB
        // was available, resolveMemoryIdInput passes the prefix through
        // unchanged, and "(resolved to <the same prefix>)" would be false.
        const message =
          classification.kind === "prefix"
            ? id !== params.id
              ? `Memory not found for id prefix "${params.id}" (resolved to "${id}")`
              : `Memory not found for id prefix "${params.id}"`
            : `Memory not found with id "${id}"`;
        throw new Error(message);
      }

      return record;
    },
  });

  // ── memory.list ───────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.list",
    category: CommandCategory.MEMORY,
    name: "list",
    description: "Browse memory records with optional type/scope/project filters.",
    parameters: memoryListParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.list", {
        type: params.type,
        scope: params.scope,
        limit: params.limit,
      });

      const service = await resolveMemoryService(deps, ctx ?? {});

      // ADR-021 / mt#2416: resolve project scope for this query.
      const projectScope = await resolveMemoryProjectScope(params.allProjects, ctx ?? {});

      let records = await service.list({
        type: params.type,
        scope: params.scope,
        projectId: params.projectId,
        projectScope,
        excludeSuperseded: params.excludeSuperseded,
        stale: params.stale,
        stalenessDays: params.stalenessDays,
        association:
          params.associationType && params.associationTarget
            ? { type: params.associationType, targetId: params.associationTarget }
            : undefined,
      });

      if (params.limit !== undefined) {
        records = records.slice(0, params.limit);
      }

      return { records };
    },
  });

  // ── memory.create ─────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.create",
    category: CommandCategory.MEMORY,
    name: "create",
    description:
      "Create a new memory record. Validates content against the derivation-discipline " +
      "rubric (mt#960) — use force=true to bypass.",
    parameters: memoryCreateParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.create", { name: params.name, force: params.force });

      // Derivation-discipline check
      const issue = checkDerivation(params.content);
      if (issue && !params.force) {
        throw new Error(issue.message);
      }
      if (issue && params.force) {
        log.warn("[memory.create] Derivation issue bypassed via force=true", {
          source: issue.source,
          name: params.name,
        });
      }

      const service = await resolveMemoryService(deps, ctx ?? {});

      // ADR-021 / mt#2416: default projectId to the resolved current project
      // scope when the caller has not explicitly supplied one. An explicit
      // params.projectId is always respected (even if it differs from the
      // current-project scope — e.g., a migration tool). When scope is
      // ALL_PROJECTS / unidentified, the returned value is undefined → null,
      // which preserves current behavior (cross-project inserts).
      const resolvedProjectId =
        params.projectId != null
          ? params.projectId
          : ((await resolveMemoryProjectScope(false, ctx ?? {})) ?? null);

      const input: MemoryCreateInput = {
        type: params.type,
        name: params.name,
        description: params.description,
        content: params.content,
        // mt#2663: scope is optional at this layer (defaultValue: "project" on
        // the parameter definition above); defend here too in case execute()
        // is invoked directly (e.g. tests) bypassing the MCP/CLI default-value
        // application.
        scope: params.scope ?? MEMORY_SCOPES.project,
        projectId: resolvedProjectId,
        tags: params.tags ?? [],
        sourceAgentId: params.sourceAgentId ?? null,
        sourceSessionId: params.sourceSessionId ?? null,
        confidence: params.confidence ?? null,
        associations: params.associations,
      };

      const record = await service.create(input);

      // Best-effort system event for the plant-board activity stream (mt#2489).
      // Never affects the create outcome.
      await emitSystemEventBestEffort(ctx?.container, {
        eventType: "memory.created",
        payload: { memoryId: record.id, memoryType: record.type, scope: record.scope },
      });

      return record;
    },
  });

  // ── memory.update ─────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.update",
    category: CommandCategory.MEMORY,
    name: "update",
    description: "Update fields on an existing memory record.",
    parameters: memoryUpdateParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.update", { id: params.id });

      const service = await resolveMemoryService(deps, ctx ?? {});

      const { id, ...updateFields } = params;
      const record = await service.update(id, updateFields);

      if (!record) {
        throw new Error(`Memory not found: "${id}"`);
      }

      return record;
    },
  });

  // ── memory.delete ─────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.delete",
    category: CommandCategory.MEMORY,
    name: "delete",
    description: "Delete a memory record by its identifier.",
    parameters: memoryDeleteParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.delete", { id: params.id });

      const service = await resolveMemoryService(deps, ctx ?? {});
      await service.delete(params.id);

      return { deleted: true, id: params.id };
    },
  });

  // ── memory.similar ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.similar",
    category: CommandCategory.MEMORY,
    name: "similar",
    description:
      "Find memory records semantically similar to an existing one. " +
      "Excludes the source memory from results. Accepts a full UUID or an " +
      "unambiguous prefix (>=8 hex chars, mt#2696) for `id`.",
    parameters: memorySimilarParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.similar", { id: params.id, limit: params.limit });

      // mt#2696: resolve a short-prefix citation before it reaches a
      // Postgres `uuid` column comparison.
      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});
      const results: MemorySearchResult[] = await service.similar(id, {
        limit: params.limit ?? 10,
        threshold: params.threshold,
      });

      return { results };
    },
  });

  // ── memory.supersede ──────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.supersede",
    category: CommandCategory.MEMORY,
    name: "supersede",
    description:
      "Atomically replace an existing memory with a new one. " +
      "The old memory is retained but marked superseded.",
    parameters: memorySupersededParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.supersede", { oldId: params.oldId });

      const service = await resolveMemoryService(deps, ctx ?? {});

      const newInput: MemoryCreateInput = {
        type: params.type,
        name: params.name,
        description: params.description,
        content: params.content,
        scope: params.scope,
        projectId: params.projectId ?? null,
        tags: params.tags ?? [],
        sourceAgentId: params.sourceAgentId ?? null,
        sourceSessionId: params.sourceSessionId ?? null,
        confidence: params.confidence ?? null,
      };

      const result: { old: MemoryRecord; replacement: MemoryRecord } = await service.supersede(
        params.oldId,
        newInput,
        params.reason
      );

      return result;
    },
  });

  // ── memory.lineage ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.lineage",
    category: CommandCategory.MEMORY,
    name: "lineage",
    description:
      "Trace the supersession chain for a memory, from oldest ancestor to newest descendant. " +
      "Each step carries the supersession_reason in its metadata. Accepts a full UUID or " +
      "an unambiguous prefix (>=8 hex chars, mt#2696) for `id`.",
    parameters: memoryLineageParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.lineage", { id: params.id });

      // mt#2696: resolve a short-prefix citation before it reaches a
      // Postgres `uuid` column comparison.
      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});
      const result = await service.lineage(id);
      return result;
    },
  });
}
