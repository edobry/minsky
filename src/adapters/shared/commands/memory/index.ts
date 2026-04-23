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
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type CommandDefinition,
} from "../../command-registry";
import { log } from "../../../../utils/logger";
import { getErrorMessage } from "../../../../errors/index";
import type { EmbeddingService } from "../../../../domain/ai/embeddings/types";
import type { VectorStorage } from "../../../../domain/storage/vector/types";
import type { MemoryServiceSurface } from "../../../../domain/memory/memory-service";
import type { MemoryServiceDb } from "../../../../domain/memory/memory-service";
import type {
  MemoryType,
  MemoryScope,
  MemoryRecord,
  MemoryCreateInput,
  MemorySearchResult,
} from "../../../../domain/memory/types";
import { MEMORY_TYPES, MEMORY_SCOPES } from "../../../../domain/memory/types";
import { checkDerivation } from "../../../../domain/memory/validation";

// ─── Zod enum helpers ────────────────────────────────────────────────────────

const memoryTypeValues = Object.values(MEMORY_TYPES) as [MemoryType, ...MemoryType[]];
const memoryScopeValues = Object.values(MEMORY_SCOPES) as [MemoryScope, ...MemoryScope[]];

// ─── Parameter shapes ─────────────────────────────────────────────────────────

export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: MemoryType;
  scope?: MemoryScope;
  projectId?: string;
  excludeSuperseded?: boolean;
}

export interface MemoryGetParams {
  id: string;
}

export interface MemoryListParams {
  type?: MemoryType;
  scope?: MemoryScope;
  projectId?: string;
  excludeSuperseded?: boolean;
  limit?: number;
}

export interface MemoryCreateParams {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  confidence?: number | null;
  force?: boolean;
}

export interface MemoryUpdateParams {
  id: string;
  type?: MemoryType;
  name?: string;
  description?: string;
  content?: string;
  scope?: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  confidence?: number | null;
}

export interface MemoryDeleteParams {
  id: string;
}

export interface MemorySimilarParams {
  id: string;
  limit?: number;
  threshold?: number;
}

export interface MemorySupersededParams {
  oldId: string;
  // newInput fields — flattened into top-level params (mirrors knowledge convention)
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  confidence?: number | null;
  reason?: string;
}

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
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return",
    required: false as const,
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
    description: "Scope of the memory (project | user | cross_project)",
    required: true as const,
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
      "../../../../domain/storage/vector/memory-vector-storage"
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
    "../../../../domain/ai/embedding-service-factory"
  );
  const embeddingService = await createEmbeddingServiceFromConfig();

  let vectorStorage: VectorStorage;
  if (persistence) {
    const { createVectorStorageFromConfig } = await import(
      "../../../../domain/storage/vector/vector-storage-factory"
    );
    vectorStorage = await createVectorStorageFromConfig(1536, persistence);
  } else {
    log.warn("[memory] No persistence provider; using in-memory vector storage");
    const { MemoryVectorStorage } = await import(
      "../../../../domain/storage/vector/memory-vector-storage"
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

  const { PersistenceProvider } = await import("../../../../domain/persistence/types");
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

  const { MemoryService: MemoryServiceClass } = await import("../../../../domain/memory");
  return new MemoryServiceClass({ db, vectorStorage, embeddingService });
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
    execute: async (params: MemorySearchParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.search", { query: params.query, limit: params.limit });

      const service = await resolveMemoryService(deps, ctx ?? {});

      try {
        const response = await service.search(params.query, {
          limit: params.limit ?? 10,
          filter: {
            type: params.type,
            scope: params.scope,
            projectId: params.projectId,
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
    description: "Fetch a single memory record by its identifier.",
    parameters: memoryGetParams,
    execute: async (params: MemoryGetParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.get", { id: params.id });

      const service = await resolveMemoryService(deps, ctx ?? {});
      const record = await service.get(params.id);

      if (!record) {
        throw new Error(`Memory not found: "${params.id}"`);
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
    execute: async (params: MemoryListParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.list", {
        type: params.type,
        scope: params.scope,
        limit: params.limit,
      });

      const service = await resolveMemoryService(deps, ctx ?? {});
      let records = await service.list({
        type: params.type,
        scope: params.scope,
        projectId: params.projectId,
        excludeSuperseded: params.excludeSuperseded,
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
    execute: async (params: MemoryCreateParams, ctx?: CommandExecutionContext) => {
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

      const input: MemoryCreateInput = {
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

      const record = await service.create(input);
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
    execute: async (params: MemoryUpdateParams, ctx?: CommandExecutionContext) => {
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
    execute: async (params: MemoryDeleteParams, ctx?: CommandExecutionContext) => {
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
      "Excludes the source memory from results.",
    parameters: memorySimilarParams,
    execute: async (params: MemorySimilarParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.similar", { id: params.id, limit: params.limit });

      const service = await resolveMemoryService(deps, ctx ?? {});
      const results: MemorySearchResult[] = await service.similar(params.id, {
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
    execute: async (params: MemorySupersededParams, ctx?: CommandExecutionContext) => {
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
}
