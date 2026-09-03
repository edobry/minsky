/**
 * Memory Commands
 *
 * Commands for creating, searching, listing, updating, patching, deleting, and
 * superseding memory records.  Registers 10 commands in the shared command
 * registry under the MEMORY category:
 *   - memory.search    — semantic search over memory records
 *   - memory.get       — fetch a single memory by id
 *   - memory.list      — browse memories with optional filters
 *   - memory.create    — create a new memory (with derivation-discipline check)
 *   - memory.update    — update fields on an existing memory (whole-content write)
 *   - memory.patch     — edit ONE markdown section, leaving the rest byte-identical
 *   - memory.delete    — delete a memory by id
 *   - memory.similar   — find memories similar to an existing one
 *   - memory.supersede — atomically replace an existing memory
 *   - memory.lineage   — trace a memory's supersession chain
 *
 * The count above was already wrong before mt#3602 (it said 8 while listing 9);
 * corrected here rather than incremented, since this file's edit made it worse.
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
import { patchSection } from "./section-patch";
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
import { MEMORY_TYPES, MEMORY_SCOPES, toMemorySummary } from "@minsky/domain/memory/types";
import { checkDerivation } from "@minsky/domain/memory/validation";
import {
  validateAssociations,
  summarizeAssociationIssues,
  TRACKS_TASK_ASSOCIATION,
  ASSOCIATION_TYPE_TUPLE,
} from "@minsky/domain/memory/associations";
import { extractTrackingTaskRefs } from "@minsky/domain/memory/staleness";
import { emitSystemEventBestEffort } from "../system-event-emit";
import { memoriesTable } from "@minsky/domain/storage/schemas/memory-embeddings";
import {
  classifyIdInput,
  resolveEntityIdPrefixOrThrow,
} from "@minsky/domain/utils/id-prefix-resolver";

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
    // uuid FK to projects.id (mt#4668) — validated here, at the command boundary, so a
    // malformed value is rejected with a message naming the parameter (mt#3155's MCP
    // parse-on-provided-value path; normalizeCliParameters mirrors it on the CLI side)
    // rather than reaching the driver as a raw 22P02 cast error.
    schema: z.string().uuid(),
    description: "Filter by project identifier (uuid)",
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
    description:
      "Memory record identifier — full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), " +
      "or a mem#N short id (mt#2966)",
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
    // uuid FK to projects.id (mt#4668) — see memorySearchParams.projectId's comment.
    schema: z.string().uuid(),
    description: "Filter by project identifier (uuid)",
    required: false as const,
  },
  excludeSuperseded: {
    schema: z.boolean(),
    description: "When true, exclude superseded memories",
    required: false as const,
    defaultValue: false,
  },
  unreadOrCold: {
    schema: z.boolean(),
    description:
      "When true, filter to memories never read OR last read longer ago than the threshold",
    required: false as const,
    defaultValue: false,
  },
  unreadOrColdDays: {
    schema: z.number().int().positive(),
    description: "Threshold (in days) for the --unread-or-cold filter; defaults to 90",
    required: false as const,
  },
  // Deprecated aliases for the two params above, renamed by mt#4799 because
  // "stale" already means "this memory's tracking task shipped" everywhere else
  // in the codebase (`staleness.ts`, `task-state-assertion.ts`). Kept working
  // rather than broken: this is an agent-facing tool surface, so a caller
  // outside the repo can be passing --stale today and there is no way to find
  // them. How the pair combines is `foldUnreadOrColdAliases` below.
  stale: {
    schema: z.boolean(),
    description: "DEPRECATED alias for --unread-or-cold (mt#4799).",
    required: false as const,
    defaultValue: false,
  },
  stalenessDays: {
    schema: z.number().int().positive(),
    description: "DEPRECATED alias for --unread-or-cold-days (mt#4799).",
    required: false as const,
  },
  // mt#4767 curation filters. Added here as well as in the cockpit so the two
  // surfaces can express the same populations — a filter the UI can reach and
  // the tool cannot is how the two drift.
  untagged: {
    schema: z.boolean(),
    description: "When true, filter to memories carrying no tags at all",
    required: false as const,
    defaultValue: false,
  },
  neverAccessed: {
    schema: z.boolean(),
    description:
      "When true, filter to memories never read since creation. Narrower than " +
      "--unread-or-cold, " +
      "which also matches records that WERE read but not recently",
    required: false as const,
    defaultValue: false,
  },
  cold: {
    schema: z.boolean(),
    description:
      "When true, filter to memories that were read at least once but not within " +
      "--cold-days. Disjoint from --never-accessed; --unread-or-cold is the union of the two",
    required: false as const,
    defaultValue: false,
  },
  coldDays: {
    schema: z.number().int().positive(),
    description: "Threshold (in days) for the --cold filter; defaults to 14",
    required: false as const,
  },
  onlySuperseded: {
    schema: z.boolean(),
    description:
      "When true, return ONLY superseded memories. Not the inverse of " +
      "--exclude-superseded, which can exclude them but never restrict to them",
    required: false as const,
    defaultValue: false,
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
  // mt#2817: time-window filters, mirroring tasks_list's since/until (both accept
  // YYYY-MM-DD or relative 7d/24h/30m). Filters on createdAt — see
  // MemoryListFilter's doc comment in packages/domain/src/memory/types.ts for why.
  since: {
    schema: z.string(),
    description: "Only include memories created on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false as const,
  },
  until: {
    schema: z.string(),
    description: "Only include memories created on/before this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false as const,
  },
  // mt#4761: sort/dir/offset/tags/nameContains — applied IN SQL by
  // MemoryService.list(). Previously this surface capped results in-memory
  // (applyListCap) with no ordering, sorting, or offset support at all.
  sort: {
    schema: z.enum(["created", "updated", "lastAccessed", "accessCount", "shortId", "name"]),
    description:
      "Sort field, applied in SQL. Defaults to 'created' (ignored when unreadOrCold:true)",
    required: false as const,
  },
  dir: {
    schema: z.enum(["asc", "desc"]),
    description: "Sort direction. Defaults to 'desc' (ignored when unreadOrCold:true)",
    required: false as const,
  },
  offset: {
    schema: z.number().int().nonnegative(),
    description: "Rows to skip, applied via SQL OFFSET. Defaults to 0",
    required: false as const,
  },
  tags: {
    schema: z.array(z.string()),
    description: "Filter by tags — AND semantics: a matching record must carry EVERY listed tag",
    required: false as const,
  },
  nameContains: {
    schema: z.string(),
    description: "Case-insensitive substring filter over name",
    required: false as const,
  },
  // mt#2817: opt-in compact projection — id/name/type/description/tags/dates,
  // NO content body. Default is false (full records) because at least one
  // known consumer (.minsky/skills/verify-task/skill.ts's bridge-memory audit
  // step) reads `content`/`description` off memory_list results directly; an
  // opt-in flag avoids silently breaking that consumer's default call shape.
  summary: {
    schema: z.boolean(),
    description:
      "When true, return compact rows (id, name, type, description, tags, createdAt, updatedAt) with no content body",
    required: false as const,
    defaultValue: false,
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
    // uuid FK to projects.id (mt#4668) — see memorySearchParams.projectId's comment.
    schema: z.string().uuid().nullable(),
    description: "Project identifier (uuid; required when scope=project)",
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
    // Key type is the CLOSED ADR-012 vocabulary (mt#4448), so the CLI/MCP parameter help
    // lists the allowed keys and a bad one fails at the schema rather than at the runtime
    // validator. The runtime check in `execute` still runs — it also validates id SHAPES,
    // which a key enum cannot express. PR #3295 R1 (non-blocking).
    // `partialRecord`, NOT `record` (mt#4528). In Zod 4 an enum-keyed `z.record` is
    // EXHAUSTIVE: it requires every enum member to be present, so `z.record` here demanded
    // all eight association types on every call and rejected every valid partial map —
    // including `{tracksTask: ["mt#1"]}`. `partialRecord` keeps the property this schema is
    // for (an out-of-vocabulary key is rejected) without the one it must not have.
    schema: z.partialRecord(z.enum(ASSOCIATION_TYPE_TUPLE), z.array(z.string())),
    description: `Structured entity associations (e.g., { tracksTask: ["mt#2053"] }). Allowed keys: ${ASSOCIATION_TYPE_TUPLE.join(", ")}. See ADR-012.`,
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
    // uuid FK to projects.id (mt#4668) — see memorySearchParams.projectId's comment.
    schema: z.string().uuid().nullable(),
    description: "New project identifier (uuid)",
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
    // DELIBERATELY still `z.string()` keys, unlike create above (PR #3295 R1). This command's
    // merge semantics make an empty array a key REMOVAL, and the keys most needing removal are
    // precisely the out-of-vocabulary ones. An enum here would make the 26 divergent records
    // uncleanable through the supported path — the schema would reject the very key you are
    // trying to delete. The runtime validator enforces the vocabulary for non-empty writes and
    // exempts removals; see `validateAssociations(..., "update")`.
    schema: z.record(z.string(), z.array(z.string())),
    description:
      "Merge associations: new keys added, existing keys replaced, keys set to [] removed. " +
      "Non-empty values must use an ADR-012 type; any key may be set to [] to remove it.",
    required: false as const,
  },
} satisfies CommandParameterMap;

const memoryPatchParams = {
  id: {
    schema: z.string(),
    description:
      "Memory record identifier — full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), " +
      "or a mem#N short id (mt#2966)",
    required: true as const,
  },
  section: {
    schema: z.string(),
    description:
      'Markdown section heading to target, with or without leading hashes (e.g. "## Recurrences"). ' +
      "Matched case-insensitively against the whole heading text — a prefix does not match.",
    required: true as const,
  },
  text: {
    schema: z.string(),
    description:
      "Text to insert (append/prepend), or the section's new body (replace). " +
      "May span multiple lines.",
    required: true as const,
  },
  mode: {
    schema: z.enum(["append", "prepend", "replace"]),
    description:
      "append (default) inserts after the section's last content line; prepend inserts " +
      "directly under the heading; replace swaps the section body.",
    required: false as const,
    defaultValue: "append" as const,
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
  allProjects: {
    schema: z.boolean().optional(),
    description:
      "Return similar memories from all projects (disable project-scope filtering; ADR-021, mt#2939)",
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
    // uuid FK to projects.id (mt#4668) — see memorySearchParams.projectId's comment.
    schema: z.string().uuid().nullable(),
    description: "Project identifier for the replacement (uuid)",
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
    // mt#3636: the capability dump alone cannot tell "never configured" from
    // "configured and unreachable" — both are all-false. Name the cause.
    const { describePersistenceUnavailability } = await import(
      "@minsky/domain/persistence/unconfigured-provider"
    );
    throw new Error(
      // sql-capability-message: already cause-carrying — mt#3636 adopted the
      // helper here; the phrase below is this caller's own prefix to it.
      "Memory service requires a SQL-capable persistence provider (Postgres). " +
        `${describePersistenceUnavailability(persistence)} ` +
        `Provider capabilities: ${JSON.stringify(persistence.capabilities)}`
    );
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error(
      "Memory service requires an initialized Postgres database connection; got null."
    );
  }

  const db = connection as MemoryServiceDb;

  // mt#1709: the tasks table lives in the same Postgres connection, so read-time staleness
  // annotation costs one extra query per search and no new service dependency. Taken off
  // the barrel rather than a deep path — that specifier is already proven to resolve at
  // runtime here, and a deep import's `exports` resolution is exactly the class of thing
  // that typechecks clean and fails on first execution (mt#2760).
  const {
    MemoryService: MemoryServiceClass,
    createTaskStatusLookup,
    createInterveningTaskLookup,
  } = await import("@minsky/domain/memory");
  return new MemoryServiceClass({
    db,
    vectorStorage,
    embeddingService,
    taskStatusLookup: createTaskStatusLookup(db),
    // mt#4452: trigger 2. Same connection, same reasoning as above — `tasks` and `task_specs`
    // live beside `memories`, so this costs a query on the few records that carry a dated
    // measurement and no new service dependency.
    interveningTaskLookup: createInterveningTaskLookup(db),
  });
}

// ─── mt#4799 deprecated-alias folding ────────────────────────────────────────

/**
 * The alias-bearing subset of `memory.list`'s params (mt#4799).
 *
 * Named `...AliasInput`, not `...AliasParams`: it is a projection this helper
 * takes, not a handler's param type, and `custom/no-hand-rolled-command-params`
 * reserves the `*Params` namespace for types derived from a params map.
 */
export interface UnreadOrColdAliasInput {
  unreadOrCold?: boolean;
  stale?: boolean;
  unreadOrColdDays?: number;
  stalenessDays?: number;
}

/**
 * Fold the deprecated `stale` / `stalenessDays` params into the current
 * `unreadOrCold` / `unreadOrColdDays` names (mt#4799).
 *
 * **The two halves combine DIFFERENTLY, and neither is an oversight.** PR #3593
 * R1 caught a comment here claiming `unreadOrCold` "wins when both are
 * supplied". It does not — and for the flag it cannot:
 *
 * - **The flag ORs.** Both params declare `defaultValue: false`, so an omitted
 *   flag and an explicit `--unread-or-cold=false` arrive at this function
 *   identically. There is no value a caller can send meaning "off, and override
 *   the alias", so precedence is not expressible here; the honest semantics are
 *   "either flag turns the filter on", which is also what a caller passing
 *   only the deprecated name expects.
 * - **The threshold uses `??`, which IS precedence.** `unreadOrColdDays` has no
 *   default, so `undefined` genuinely distinguishes "not supplied" from any
 *   real value, and an explicit current-name threshold beats the alias.
 *
 * Extracted from the inline expression so the asymmetry is stated once and
 * asserted directly, rather than being re-derived from two operators.
 */
export function foldUnreadOrColdAliases(params: UnreadOrColdAliasInput): {
  unreadOrCold: boolean;
  unreadOrColdDays: number | undefined;
} {
  return {
    unreadOrCold: Boolean(params.unreadOrCold || params.stale),
    unreadOrColdDays: params.unreadOrColdDays ?? params.stalenessDays,
  };
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
    // Pass the handle through UNCOPIED (mt#4509). This previously read
    // `const { type: _t, ...db } = rawDb`, and an object rest-spread copies only own
    // enumerable properties — drizzle defines `select` on the prototype, so every copy
    // arrived without it and every call threw `db.select is not a function`. The stripped
    // `type` key does not exist on the handle, so the destructuring bought nothing.
    const scope = await resolveProjectScope(identity, rawDb, "memory");
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
 * Resolve a caller-supplied memory id — a full UUID, an unambiguous 8-char
 * hex prefix (mt#2696), or a `mem#N` short id (mt#2966/mt#2963) — to the
 * full UUID `memories.id` before it reaches any `eq(memoriesTable.id, ...)`
 * comparison. A full UUID passes through unchanged with no query. A
 * short/no-match/ambiguous prefix, or a `mem#N` with no matching row, throws
 * a clean tool-level error (never a raw Postgres "invalid input syntax for
 * type uuid" error).
 *
 * When no DB connection is resolvable here, the raw input is passed through —
 * the immediately-following `resolveMemoryService` call in every command
 * surfaces the "persistence provider required" error instead.
 *
 * Exported for unit testing (memory-commands.test.ts) — not part of the
 * public command surface.
 */
export async function resolveMemoryIdInput(
  id: string,
  ctx: CommandExecutionContext
): Promise<string> {
  const db = await resolveMemoryDbForPrefix(ctx);
  if (!db) return id;

  return resolveEntityIdPrefixOrThrow({
    db,
    table: memoriesTable,
    idColumn: memoriesTable.id,
    labelColumn: memoriesTable.name,
    input: id,
    entityName: "memory",
    shortIdColumn: memoriesTable.shortId,
    shortIdPrefix: "mem",
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
      "Fetch a single memory record by its identifier. Accepts a full UUID, an " +
      "unambiguous prefix (>=8 hex chars, mt#2696) — e.g. an id cited in a handoff — " +
      "or a mem#N short id (mt#2966).",
    parameters: memoryGetParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.get", { id: params.id });

      // mt#2696: resolve a short-prefix citation to the full uuid before it
      // ever reaches a Postgres `uuid` column comparison.
      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});
      // mt#4743: the annotating read. `search()` has carried a staleness verdict since
      // mt#1709 while this path — the one an agent takes when a handoff or a spec named a
      // record BY ID — returned the row unannotated, which is the load-bearing case.
      const result = await service.getWithStaleness(id);

      if (!result) {
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

      // mt#4743: ADDITIVE. Every field of the record stays at the path it has always been
      // at and `staleness` sits alongside them, so no existing `memory.get` consumer sees a
      // shape change; the key is absent entirely for a record that declares no retirement
      // relationship, matching `MemorySearchResult`'s optional-not-"current" convention.
      return result.staleness === undefined
        ? result.record
        : { ...result.record, staleness: result.staleness };
    },
  });

  // ── memory.list ───────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.list",
    category: CommandCategory.MEMORY,
    name: "list",
    description:
      "Browse memory records with optional type/scope/project filters, sorted and paginated " +
      "in SQL (mt#4761). Defaults to created desc when --sort is omitted. Supports --sort " +
      "(created|updated|lastAccessed|accessCount|shortId|name), --dir (asc|desc), --offset, " +
      "--tags (AND semantics — every listed tag must be present), and --name-contains " +
      "(case-insensitive substring match).",
    parameters: memoryListParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.list", {
        type: params.type,
        scope: params.scope,
        limit: params.limit,
        summary: params.summary,
      });

      const service = await resolveMemoryService(deps, ctx ?? {});

      // ADR-021 / mt#2416: resolve project scope for this query.
      const projectScope = await resolveMemoryProjectScope(params.allProjects, ctx ?? {});

      // mt#2817: since/until accept the same YYYY-MM-DD / 7d/24h/30m forms as
      // tasks_list's since/until — resolve to ISO strings before handing to
      // the domain filter, which pushes the window down into the SQL query.
      const { parseTime } = await import("../../../../utils/result-handling/filters");
      const sinceTs = parseTime(params.since);
      const untilTs = parseTime(params.until);

      // mt#4761: sort/dir/offset/tags/nameContains forwarded to the domain
      // filter, which now applies them (plus limit) IN SQL — a filter that
      // existed only for the cockpit was a second implementation waiting to
      // happen. `limit` is passed through too: MemoryService.list() defaults
      // it to DEFAULT_LIST_CAP (500) when omitted, matching pre-mt#4761
      // behavior for this surface.
      const listFilter = {
        type: params.type,
        scope: params.scope,
        projectId: params.projectId,
        projectScope,
        excludeSuperseded: params.excludeSuperseded,
        // mt#4799: the deprecated aliases fold in here, so the domain surface
        // sees only the current names. See {@link foldUnreadOrColdAliases} for
        // why the two halves combine DIFFERENTLY.
        ...foldUnreadOrColdAliases(params),
        untagged: params.untagged,
        neverAccessed: params.neverAccessed,
        cold: params.cold,
        coldDays: params.coldDays,
        onlySuperseded: params.onlySuperseded,
        association:
          params.associationType && params.associationTarget
            ? { type: params.associationType, targetId: params.associationTarget }
            : undefined,
        since: sinceTs !== null ? new Date(sinceTs).toISOString() : undefined,
        until: untilTs !== null ? new Date(untilTs).toISOString() : undefined,
        sort: params.sort,
        dir: params.dir,
        limit: params.limit,
        offset: params.offset,
        tags: params.tags,
        nameContains: params.nameContains,
      };

      const records = await service.list(listFilter);

      // mt#4761 (PR #3488 R1 NON-BLOCKING 2): `applyListCap` runs
      // UNCONDITIONALLY — the returned/truncated computation must not assume
      // `list()` already capped to `params.limit`. A `MemoryServiceSurface`
      // fake that ignores `limit` entirely (returns the full unfiltered set,
      // e.g. `memory-commands.test.ts`'s fake) needs this exactly as much as
      // the real SQL-backed service does, which already returns a page at
      // most `params.limit` long — capping an already-capped array is a
      // no-op, so this is safe either way.
      const { applyListCap, computeListTruncation } = await import(
        "@minsky/domain/utils/list-pagination"
      );
      const capped = applyListCap(records, params.limit);
      const cappedRecords: MemoryRecord[] = capped.items;
      let truncation: { returned: number; total: number; truncated: boolean } = capped.meta;

      // Prefer a true SQL count over `applyListCap`'s own `total` (which is
      // only accurate when `records` already held every matching row —
      // false once `list()` applies its own SQL-side cap).
      if (service.count) {
        const total = await service.count(listFilter);
        truncation = computeListTruncation(total, cappedRecords.length);
      }

      // mt#2817: opt-in compact projection — strip content (and every other
      // non-summary field) so a browse-style query doesn't ship multi-KB
      // bodies the caller didn't ask for. Default (summary:false) is
      // unchanged from the pre-mt#2817 shape. mt#4761: reuses the SAME
      // projection the cockpit's memories-list widget now uses
      // (`toMemorySummary`), so the two surfaces cannot drift.
      const outputRecords = params.summary ? cappedRecords.map(toMemorySummary) : cappedRecords;

      return { records: outputRecords, ...truncation };
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

      // ADR-012 vocabulary check (mt#4448). Deliberately NOT gated on `force`: that flag
      // bypasses the derivation heuristic above, which is a judgment call about content.
      // The association vocabulary is a closed set, and an override would restore the exact
      // condition the mt#4448 census measured — 26 of 28 records keyed on invented strings.
      const associationIssues = validateAssociations(params.associations);
      const associationError = summarizeAssociationIssues(associationIssues);
      if (associationError) {
        throw new Error(associationError);
      }

      // Derive `tracksTask` from a retirement clause the author already wrote (mt#4448).
      // The other half of the write-side criterion: rejecting bad keys stops the corpus
      // getting worse, but the reason 1198 of 1226 records carry NO association is that
      // setting one is a separate thing to remember. An author who writes "Tracking task:
      // mt#X" in the body has already stated the relationship; making them restate it as a
      // structured argument is the step that does not happen.
      //
      // Reuses `extractTrackingTaskRefs` — the CALIBRATED extractor mt#1709 shipped, which
      // requires an explicit retirement RELATIONSHIP rather than a bare task mention. A
      // looser pattern here would mint exactly the noise this task removed from the backfill.
      //
      // Only fires when the caller supplied no `tracksTask`: an explicit argument always wins,
      // including an explicit empty array.
      const associations = { ...(params.associations ?? {}) };
      if (associations[TRACKS_TASK_ASSOCIATION] === undefined) {
        const derived = extractTrackingTaskRefs({
          content: params.content,
          ...(params.description === undefined ? {} : { description: params.description }),
        });
        if (derived.source === "text" && derived.refs.length > 0) {
          associations[TRACKS_TASK_ASSOCIATION] = derived.refs;
          log.debug("[memory.create] derived tracksTask from a retirement clause", {
            name: params.name,
            refs: derived.refs,
          });
        }
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
        associations,
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
    description:
      "Update fields on an existing memory record. Accepts a full UUID, an " +
      "unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N short id " +
      "(mt#2966) for `id`.",
    parameters: memoryUpdateParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.update", { id: params.id });

      // Resolve BEFORE building the service, matching the read commands'
      // ordering (PR #2348 R1). Same resolver they use (mt#3108): a full uuid,
      // an unambiguous >=8-hex prefix, or a `mem#N` short id, throwing a named
      // error rather than letting a non-uuid reach the driver as a cast.
      const { id: rawId, ...updateFields } = params;
      const id = await resolveMemoryIdInput(rawId, ctx ?? {});

      // ADR-012 vocabulary check (mt#4448), in `update` mode: an empty value array is a
      // key REMOVAL under this command's merge semantics and stays legal for any key, so
      // the divergent keys can be cleaned up through the supported path. A non-empty value
      // under an unknown key is rejected exactly as it is on create.
      const associationError = summarizeAssociationIssues(
        validateAssociations(updateFields.associations, "update")
      );
      if (associationError) {
        throw new Error(associationError);
      }

      const service = await resolveMemoryService(deps, ctx ?? {});
      const record = await service.update(id, updateFields);

      if (!record) {
        throw new Error(`Memory not found: "${rawId}"`);
      }

      return record;
    },
  });

  // ── memory.patch ──────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.patch",
    category: CommandCategory.MEMORY,
    name: "patch",
    description:
      "Append to, prepend to, or replace ONE markdown section of a memory's content, " +
      "leaving every other byte unchanged (mt#3602). Use this instead of `memory.update` " +
      "when adding an entry to a long-lived record — appending an R-entry to a family " +
      "root's `## Recurrences` is the canonical case. Fails loudly when the section is " +
      "missing or appears more than once; never falls back to a wholesale write. " +
      "Accepts a full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N " +
      "short id (mt#2966).",
    parameters: memoryPatchParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.patch", { id: params.id, section: params.section });

      const id = await resolveMemoryIdInput(params.id, ctx ?? {});
      const service = await resolveMemoryService(deps, ctx ?? {});

      // Deliberately the non-tracking read: this read exists to serve the
      // WRITE below, so counting it would inflate the access stats that mark a
      // record as heavily-cited — see getWithoutAccessTracking's own comment.
      const existing = await service.getWithoutAccessTracking(id);
      if (!existing) {
        throw new Error(`Memory not found: "${params.id}"`);
      }

      // The splice runs BEFORE any write, so a missing or ambiguous section
      // aborts with the record untouched rather than half-patched.
      const patched = patchSection({
        content: existing.content,
        section: params.section,
        text: params.text,
        mode: params.mode ?? "append",
      });

      // Routed through the same domain service `memory.update` uses (ADR-018),
      // so embedding regeneration and `updatedAt` behave identically — the
      // reason a direct SQL append is not an acceptable shortcut here.
      const record = await service.update(id, { content: patched });
      if (!record) {
        throw new Error(`Memory not found: "${params.id}"`);
      }

      return record;
    },
  });

  // ── memory.delete ─────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.delete",
    category: CommandCategory.MEMORY,
    name: "delete",
    // mt#3924: drift-gated — irreversible deletion of a durable record.
    mutating: true,
    description:
      "Delete a memory record by its identifier. Accepts a full UUID, an " +
      "unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N short id " +
      "(mt#2966).",
    parameters: memoryDeleteParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.delete", { id: params.id });

      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});
      await service.delete(id);

      // Report the RESOLVED id: echoing the caller's `mem#N` back would leave
      // them without the canonical id of the row that was actually removed.
      return { deleted: true, id };
    },
  });

  // ── memory.similar ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "memory.similar",
    category: CommandCategory.MEMORY,
    name: "similar",
    description:
      "Find memory records semantically similar to an existing one. " +
      "Excludes the source memory from results. Accepts a full UUID, an " +
      "unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N short id " +
      "(mt#2966) for `id`.",
    parameters: memorySimilarParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.similar", { id: params.id, limit: params.limit });

      // mt#2696: resolve a short-prefix citation before it reaches a
      // Postgres `uuid` column comparison.
      const id = await resolveMemoryIdInput(params.id, ctx ?? {});

      const service = await resolveMemoryService(deps, ctx ?? {});

      // ADR-021 / mt#2939: resolve project scope for this similarity query.
      const projectScope = await resolveMemoryProjectScope(params.allProjects, ctx ?? {});

      const results: MemorySearchResult[] = await service.similar(id, {
        limit: params.limit ?? 10,
        threshold: params.threshold,
        projectScope,
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
      "The old memory is retained but marked superseded. Accepts a full UUID, " +
      "an unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N short id " +
      "(mt#2966) for `oldId`.",
    parameters: memorySupersededParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing memory.supersede", { oldId: params.oldId });

      const oldId = await resolveMemoryIdInput(params.oldId, ctx ?? {});

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
        oldId,
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
      "Each step carries the supersession_reason in its metadata. Accepts a full UUID, " +
      "an unambiguous prefix (>=8 hex chars, mt#2696), or a mem#N short id (mt#2966) for `id`.",
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
