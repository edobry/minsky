/**
 * Memory Service
 *
 * Provides CRUD + semantic search over the memories domain.
 *
 * Design notes:
 * - Two-table separation: memories (domain) + memories_embeddings (vectors).
 * - Embedding failures are non-fatal: create/update still succeed; search
 *   degrades gracefully to {backend:"none", degraded:true}.
 * - supersede() is transactional: inserts new memory and sets old.superseded_by
 *   atomically using a SQL transaction.
 * - Follows the MinskyBackendDb narrow-interface pattern to avoid
 *   `as unknown as PostgresJsDatabase` casts in tests.
 *
 * @see mt#1012 Memory Phase 1 spec
 */

import { injectable } from "tsyringe";
import {
  eq,
  and,
  isNull,
  inArray,
  or,
  lt,
  gte,
  lte,
  sql,
  asc,
  desc,
  arrayContains,
  ilike,
} from "drizzle-orm";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import {
  memoriesTable,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "../storage/schemas/memory-embeddings";
import {
  collectUnresolvedRefs,
  combineStaleness,
  combineTaskStateDrift,
  computeStaleness,
  extractTrackingTaskRefs,
} from "./staleness";
import {
  assertedTaskIds,
  computeTaskStateDrift,
  extractTaskStateAssertions,
} from "./task-state-assertion";
import { computeMeasurementDecay, extractMeasurement } from "./measurement-decay";
import { escapeLikePattern } from "./intervening-task-lookup";
import { DEFAULT_LIST_CAP, computeListTruncation } from "../utils/list-pagination";
import type { ListTruncationMetadata } from "../utils/list-pagination";

/**
 * Ceiling on measurement-decay lookups per search page (mt#4452, PR #3271 R1).
 *
 * Set above a normal page size rather than below it: the goal is a backstop against unbounded
 * growth, not a throttle on ordinary pages. `memory_search`'s default limit is 10, and only
 * 2.30% of records carry a dated measurement, so this is not reached in practice today.
 */
const MAX_MEASUREMENT_LOOKUPS_PER_PAGE = 25;

/**
 * The WHERE fragment for "scoped to one project" (mt#4530).
 *
 * Matches memories belonging to `projectScope` PLUS memories whose scope says they are not
 * bound to any project. `project_id = <uuid>` alone is not that predicate: it excludes every
 * `user` and `cross_project` memory, because those are stored with a NULL `project_id` by
 * design. Filtering them out is the opposite of what the scope values mean.
 *
 * Both read paths (`list` and the search post-filter) share this so they cannot drift.
 */
function scopedToProject(projectScope: string) {
  return or(
    eq(memoriesTable.projectId, projectScope),
    inArray(memoriesTable.scope, PROJECT_AGNOSTIC_MEMORY_SCOPES)
  );
}

/**
 * Shared WHERE-condition builder for `list()` and `count()` (mt#4761).
 *
 * Both methods must apply the EXACT same filter predicates — `count()` exists
 * to report the true total behind a `list()` page, so any drift between the
 * two would make `{returned, total, truncated}` lie. `sort`/`dir`/`limit`/
 * `offset` are deliberately excluded: they affect ORDERING/PAGINATION, not
 * which rows match.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildListConditions(filter?: MemoryListFilter): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];

  if (filter?.type) {
    conditions.push(eq(memoriesTable.type, filter.type));
  }
  if (filter?.scope) {
    conditions.push(eq(memoriesTable.scope, filter.scope));
  }
  // projectScope takes precedence over projectId when both are set (ADR-021, mt#2416)
  if (filter?.projectScope && !isAllProjects(filter.projectScope)) {
    conditions.push(scopedToProject(filter.projectScope));
  } else if (filter?.projectId) {
    conditions.push(eq(memoriesTable.projectId, filter.projectId));
  }
  if (filter?.excludeSuperseded) {
    conditions.push(isNull(memoriesTable.supersededBy));
  }
  if (filter?.stale) {
    const days = filter.stalenessDays ?? 90;
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    conditions.push(
      or(isNull(memoriesTable.lastAccessedAt), lt(memoriesTable.lastAccessedAt, threshold))
    );
  }
  if (filter?.association) {
    const { type: assocType, targetId } = filter.association;
    const containsObj = { [assocType]: [targetId] };
    conditions.push(sql`${memoriesTable.associations} @> ${JSON.stringify(containsObj)}::jsonb`);
  }
  // mt#2817: since/until filter on createdAt (see MemoryListFilter doc comment
  // for why createdAt rather than updatedAt). Invalid date strings are
  // dropped rather than throwing — same defensive posture as the rest of
  // this filter set (a bad filter degrades to "no filter", not a 500).
  if (filter?.since) {
    const since = new Date(filter.since);
    if (!Number.isNaN(since.getTime())) {
      conditions.push(gte(memoriesTable.createdAt, since));
    }
  }
  if (filter?.until) {
    const until = new Date(filter.until);
    if (!Number.isNaN(until.getTime())) {
      conditions.push(lte(memoriesTable.createdAt, until));
    }
  }
  // mt#4761: AND semantics — `arrayContains` renders `tags @> ARRAY[...]`,
  // which requires every listed tag to be present (Postgres array containment),
  // not merely one of them (that would be `&&`/arrayOverlaps, deliberately unused).
  if (filter?.tags && filter.tags.length > 0) {
    conditions.push(arrayContains(memoriesTable.tags, filter.tags));
  }
  // mt#4761: case-insensitive substring match. Escaped so a literal `%`/`_`
  // in the search text is not treated as a LIKE wildcard (Postgres's default
  // ILIKE escape character is `\`, so no explicit ESCAPE clause is needed).
  if (filter?.nameContains) {
    conditions.push(ilike(memoriesTable.name, `%${escapeLikePattern(filter.nameContains)}%`));
  }

  return conditions;
}

/**
 * Resolve a `MemoryListFilter.sort`/`dir` pair to a SQL ORDER BY fragment
 * (mt#4761). Defaults to `created desc` — see `list()`'s doc comment.
 *
 * `shortId` is stored as `text` holding the FULL formatted `mem#N` token
 * (`rowToRecord` reads `row.short_id` verbatim with no `formatShortId` call —
 * the DB column already carries the prefix), nullable for legacy
 * pre-backfill rows. A plain text sort would both order "mem#10" before
 * "mem#2" AND treat the whole string as the sort key, so the numeric suffix
 * is extracted via `split_part(..., '#', 2)` and cast to `integer`;
 * `NULLIF(..., '')` guards a value with no `#` (which `split_part` would
 * otherwise turn into `''`, and `''::integer` raises `22P02` rather than
 * sorting as absent — caught live via `bun run src/cli.ts memory list --sort
 * shortId` during this task's own verification). NULLs sort last under
 * either direction via `NULLS LAST`, keeping unminted rows out of the way
 * rather than interleaved by direction-dependent Postgres defaults.
 */
function resolveListOrderBy(
  sort: MemoryListSortField | undefined,
  dir: "asc" | "desc" | undefined
) {
  const direction = dir === "asc" ? asc : desc;
  const dirSql = dir === "asc" ? sql`asc` : sql`desc`;
  switch (sort) {
    case "updated":
      return direction(memoriesTable.updatedAt);
    case "lastAccessed":
      return sql`${memoriesTable.lastAccessedAt} ${dirSql} NULLS LAST`;
    case "accessCount":
      return direction(memoriesTable.accessCount);
    case "shortId": {
      const numericShortId = sql`NULLIF(split_part(${memoriesTable.shortId}, '#', 2), '')::integer`;
      return sql`${numericShortId} ${dirSql} NULLS LAST`;
    }
    case "name":
      return direction(memoriesTable.name);
    case "created":
    default:
      return direction(memoriesTable.createdAt);
  }
}
import { sanitizeForPostgresDeep } from "../storage/postgres-text-safety";
import { log } from "@minsky/shared/logger";
import { isAllProjects } from "../project/scope";
import { MEMORY_SCOPES } from "./types";
import { nextShortId, formatShortId, parseShortId } from "../utils/short-id";
import type {
  MemoryRecord,
  MemoryReadResult,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemoryListFilter,
  MemoryListSortField,
  MemorySearchOptions,
  MemorySearchResponse,
  MemorySearchResult,
  MemoryType,
} from "./types";

// ---------------------------------------------------------------------------
// Narrow DB interface (avoids `as unknown as PostgresJsDatabase` in tests)
// ---------------------------------------------------------------------------

/**
 * Narrow interface covering only the Drizzle methods used by MemoryService.
 * `any` return types let test fakes satisfy this without unsafe casts,
 * while the real PostgresJsDatabase satisfies it structurally.
 */
export interface MemoryServiceDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API surface interface
// ---------------------------------------------------------------------------

/**
 * Narrow public-API interface for MemoryService.
 * Use this in tests and dependency injection instead of the concrete class
 * to avoid `as unknown as MemoryService` casts.
 */
export interface MemoryServiceSurface {
  search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResponse>;
  get(id: string): Promise<MemoryRecord | null>;
  /**
   * Fetch by id AND annotate staleness, the way `search()` already does (mt#4743).
   *
   * `get()` is deliberately left un-annotated: it is the internal read used by callers
   * that want the row, not a verdict about it. This is the CONSUMER-facing read — the
   * one an agent reaches when a handoff, a spec cross-reference or a family root named
   * a record by id, which is precisely the load-bearing case mt#1709 did not cover.
   */
  getWithStaleness(id: string): Promise<MemoryReadResult | null>;
  /** Read without bumping access tracking — for read-in-order-to-write callers (mt#3602). */
  getWithoutAccessTracking(id: string): Promise<MemoryRecord | null>;
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
  /**
   * True count of memories matching `filter`, ignoring `limit`/`offset` (mt#4761).
   * OPTIONAL: a caller needing an accurate total over a real SQL-side cap
   * should prefer this when present; a `MemoryServiceSurface` fake that omits
   * it is read as "treat `list()`'s own result as the full matching set" by
   * every consumer here (the same assumption those consumers made before
   * this method existed), so omitting it is backward compatible.
   */
  count?(filter?: MemoryListFilter): Promise<number>;
  /**
   * `list()` plus the mt#2817 `{returned, total, truncated}` metadata triple, in ONE
   * caller-facing call (PR #3488 R1 BLOCKING). `list()` itself stays a plain
   * `MemoryRecord[]` — see its doc comment for the four consumers that constrains — so a
   * paginated caller that wants both the page AND an accurate total without a second
   * ROUND TRIP (the mt#4761 success criterion) calls this instead of `list()` + `count()`
   * separately. Internally this IS a paired count query (`list()` then `count()`), which
   * is the resolved form of the spec's "windowed count(*) over () or a paired count
   * query" choice: windowed loses the count entirely on a zero-row page, so paired is
   * correct regardless of which SQL statement count the reviewer meant by "round trip."
   * OPTIONAL for the same backward-compat reason as `count()` — a fake that omits it
   * makes its caller (`memories-list.ts`) fall back to `list()` + `records.length`.
   */
  listWithMeta?(
    filter?: MemoryListFilter
  ): Promise<{ records: MemoryRecord[]; meta: ListTruncationMetadata }>;
  /**
   * SQL-aggregate stats for the memories-stats cockpit widget (mt#4761).
   * OPTIONAL for the same reason as `count()` above — a fake that omits it
   * causes the widget to fall back to its pre-mt#4761 client-side computation
   * via `list()`.
   */
  getListStats?(filter?: MemoryListFilter): Promise<{
    total: number;
    supersededCount: number;
    byType: Record<MemoryType, number>;
    recentCount: number;
    topAccessed: Array<{ id: string; name: string; accessCount: number }>;
  }>;
  create(input: MemoryCreateInput): Promise<MemoryRecord>;
  update(id: string, input: MemoryUpdateInput): Promise<MemoryRecord | null>;
  delete(id: string): Promise<void>;
  similar(
    id: string,
    opts?: Pick<MemorySearchOptions, "limit" | "threshold"> & {
      /**
       * Project scope for filtering (ADR-021, mt#2939). When set to a uuid
       * string, filters results to memories belonging to that project. When
       * set to ALL_PROJECTS or omitted, returns cross-project neighbors.
       */
      projectScope?: import("../project/scope").ProjectScope;
    }
  ): Promise<MemorySearchResult[]>;
  supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }>;
  /**
   * Walk the supersession chain for a given memory ID and return the ordered chain
   * from oldest ancestor to newest descendant.
   */
  lineage(id: string): Promise<{ chain: MemoryRecord[]; truncated: boolean }>;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MemoryServiceDeps {
  db: MemoryServiceDb;
  vectorStorage: VectorStorage;
  embeddingService: EmbeddingService;
  /**
   * Batched task-status lookup used to decide whether a memory's own retirement clause has
   * already been met (mt#1709). Given task ids, return a map from id to current status;
   * omit an id (or map it to `undefined`) when it cannot be resolved — that is reported as
   * `unresolved`, never as "nothing is stale".
   *
   * An injected callback rather than a `TaskServiceInterface` for two reasons. It keeps the
   * detection path testable without standing up a task service, matching
   * `../tasks/spec-freshness.ts`'s injected-lookup shape; and it keeps the memory domain
   * from taking a hard dependency on the tasks domain for what is a read-time annotation.
   *
   * OPTIONAL by design: every existing construction site keeps working untouched, and a
   * MemoryService built without it simply returns unannotated results. Degrading to "no
   * annotation" is the correct failure here — a staleness banner is an enhancement to a
   * search result, never a precondition for returning one.
   */
  taskStatusLookup?: (taskIds: string[]) => Promise<ReadonlyMap<string, string | undefined>>;
  /**
   * Tasks that reached a completed status AFTER `since` and whose spec cites any of
   * `subsystems` (mt#4452, trigger 2). Used to decide whether a memory's dated measurement
   * still describes the system it measured.
   *
   * Same injected-callback shape and same optionality as `taskStatusLookup` above, for the
   * same reasons: the detection core stays testable without a task service, and a MemoryService
   * built without it returns results annotated by trigger 1 only.
   */
  interveningTaskLookup?: (
    subsystems: string[],
    since: Date
  ) => Promise<{ taskId: string; title: string; rowUpdatedAt?: string }[]>;
}

// ---------------------------------------------------------------------------
// Id-shape resolution (mt#3259)
// ---------------------------------------------------------------------------

/**
 * Canonical UUID shape. `memories.id` is a Postgres `uuid` column, so a
 * comparison against a non-uuid string is a CAST ERROR, not an empty result —
 * this guard is what turns a malformed id into a clean miss.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the WHERE clause selecting a single memory by its id, accepting
 * either id form (ADR-029: the uuid is canonical, the `mem#N` short id is an
 * additional display/lookup handle).
 *
 * Returns `null` — explicitly, not a clause matching nothing — when the input
 * is NEITHER form. That distinction is the point: a null return means "this
 * string cannot name a memory," which callers render as a miss without ever
 * issuing a query. Deliberately NOT typed as returning a clause that matches
 * zero rows, so a future caller can't mistake "unqueryable input" for
 * "queried and found nothing" (mem#728: an unmeasured value must not be
 * representable as a legitimate one).
 */
function memoryIdWhere(id: string) {
  const trimmed = (id ?? "").trim();
  const parsed = parseShortId(trimmed);
  if (parsed && parsed.prefix === "mem") {
    // Re-format from the PARSED parts rather than reusing the raw input, so
    // casing and stray whitespace normalize to the stored form.
    return eq(memoriesTable.shortId, formatShortId("mem", parsed.n));
  }
  if (UUID_RE.test(trimmed)) return eq(memoriesTable.id, trimmed);
  return null;
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: Record<string, any>): MemoryRecord {
  return {
    id: String(row["id"]),
    // mem#N short id (mt#2966) — undefined for legacy rows pre-backfill.
    shortId: (row["short_id"] ?? row["shortId"] ?? undefined) as string | undefined,
    type: row["type"],
    name: String(row["name"]),
    description: String(row["description"]),
    content: String(row["content"]),
    scope: row["scope"],
    projectId: row["project_id"] ?? row["projectId"] ?? null,
    tags: Array.isArray(row["tags"]) ? row["tags"] : [],
    sourceAgentId: row["source_agent_id"] ?? row["sourceAgentId"] ?? null,
    sourceSessionId: row["source_session_id"] ?? row["sourceSessionId"] ?? null,
    confidence: row["confidence"] ?? null,
    supersededBy: row["superseded_by"] ?? row["supersededBy"] ?? null,
    metadata: (row["metadata"] as Record<string, unknown> | null | undefined) ?? null,
    associations: (row["associations"] as Record<string, string[]> | null | undefined) ?? {},
    createdAt: row["created_at"] ?? row["createdAt"] ?? new Date(),
    updatedAt: row["updated_at"] ?? row["updatedAt"] ?? new Date(),
    lastAccessedAt: row["last_accessed_at"] ?? row["lastAccessedAt"] ?? null,
    accessCount: row["access_count"] ?? row["accessCount"] ?? 0,
  };
}

/**
 * Look up one memory by either id form (`mem#N` or a full uuid) and return only
 * the fields a ref cross-reference needs (mt#3354).
 *
 * Standalone rather than a `MemoryService` method because `MemoryServiceDeps`
 * requires `vectorStorage` and `embeddingService`, neither of which a by-id read
 * touches — `refs.status` holds a bare DB connection and has no reason to stand
 * up the embedding stack to answer "does this memory exist". It shares
 * `memoryIdWhere` with `MemoryService.get`, so both id forms resolve identically
 * on both paths and cannot drift apart.
 *
 * Deliberately does NOT bump `last_accessed_at`/`access_count` the way
 * `MemoryService.get` does: a bulk ref cross-reference is bookkeeping about the
 * record, not a read OF the record, and counting it would inflate the access
 * stats that surface memory relevance.
 */
export async function getMemoryRefSummary(
  db: MemoryServiceDb,
  id: string
): Promise<{ id: string; type: string; name: string } | null> {
  const where = memoryIdWhere(id);
  // Neither a uuid nor a `mem#N` short id — a genuine miss, not a query.
  if (!where) return null;
  const rows = await db.select().from(memoriesTable).where(where);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const record = rowToRecord(row);
  return { id: record.id, type: record.type, name: record.name };
}

/**
 * Look up one memory by either id form (`mem#N` or a full uuid) and return the
 * FULL record — unlike `getMemoryRefSummary` above, which deliberately narrows
 * to `{id, type, name}` for a cross-reference existence check (mt#3354).
 *
 * mt#3964: the reviewer service needs a memory's `content` to verify a success
 * criterion naming a `mem#N` artifact (e.g. "mem#648's CORRECTION 1 is
 * amended: ..."), the same way `resolveReferencedTaskSpecs`
 * (`services/reviewer/src/task-spec-fetch.ts`) verifies an `mt#NNNN` criterion
 * against another task's spec content. That mechanism goes through the full
 * `TaskServiceInterface`; the equivalent full `MemoryService` requires an
 * `embeddingService` + `vectorStorage` neither a by-id content read touches
 * (see `MemoryServiceDeps`) — standing one up just to call `.get()` would be
 * pure overhead in a service (the reviewer) that has no other reason to hold
 * an embedding client. This function needs only the narrow `MemoryServiceDb`,
 * exactly like `getMemoryRefSummary`.
 *
 * Deliberately does NOT bump `last_accessed_at`/`access_count`, for the same
 * reason `getMemoryRefSummary`/`getWithoutAccessTracking` don't: an automated
 * criterion-verification read is not a consumer read of the record, and
 * counting it would inflate the access stats that surface memory relevance.
 */
export async function getMemoryRecordById(
  db: MemoryServiceDb,
  id: string
): Promise<MemoryRecord | null> {
  const where = memoryIdWhere(id);
  // Neither a uuid nor a `mem#N` short id — a genuine miss, not a query.
  if (!where) return null;
  const rows = await db.select().from(memoriesTable).where(where);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@injectable()
export class MemoryService implements MemoryServiceSurface {
  constructor(private readonly deps: MemoryServiceDeps) {}

  // -------------------------------------------------------------------------
  // Short-id minting (mt#2966, generalizing mt#2205's `computeNextTaskId`
  // pattern via the shared `nextShortId` util — mirrors
  // `DrizzleAskRepository.nextAskShortId`, mt#2965).
  // -------------------------------------------------------------------------

  /**
   * Compute the next `mem#N` short id. Two paths, tried in order:
   *
   * 1. **Real-DB-optimized path (PR #2134 R1).** A targeted query mirroring
   *    `DrizzleAskRepository.nextAskShortId` (mt#2965 PR #2110 R1):
   *    `WHERE short_id ~ '^mem#[0-9]+$' ORDER BY (substring(... from
   *    5))::bigint DESC LIMIT 1` — fetches ONLY the single highest-numbered
   *    row's `short_id`, never the whole table. Against a real
   *    `PostgresJsDatabase`, Postgres executes the ORDER BY/LIMIT
   *    server-side, so this is a true single-row fetch, not a full-column
   *    scan.
   * 2. **Fallback: unfiltered single-column select + client-side fold.**
   *    `nextShortId` (the shared mt#2963 foundation util) folds over
   *    whatever candidate ids come back to compute the max — it internally
   *    filters to `mem#<n>`-shaped values via `parseShortId`, so this
   *    fallback is still correct even with no server-side WHERE/ORDER
   *    BY/LIMIT.
   *
   * Branching is a CAPABILITY PROBE, not a static type/instanceof check:
   * path 1 is attempted first inside a try/catch, and ANY failure (thrown
   * synchronously or via a rejected promise) falls through to path 2.
   * `MemoryServiceDb` is the deliberately narrow interface
   * (`select`/`insert`/`update`/`delete`/`transaction`) this service uses so
   * it stays testable against simple fakes without a real Drizzle client —
   * this codebase has several independent ad-hoc `MemoryServiceDb` test
   * fakes that don't implement the full `.where().orderBy().limit()` chain
   * (one even throws on a raw-SQL WHERE shape it doesn't recognize), so
   * path 1 reliably fails fast against every one of them and path 2 runs
   * instead — no fake needs updating for this to be safe. The purpose-built
   * `createFakeMemoryDb` in `memory-service.test.ts` DOES implement the
   * full chain (mirroring ask's `createFakeDrizzleAskDb`), so those tests
   * exercise path 1 for real.
   *
   * `db` defaults to `this.deps.db` but accepts an explicit `tx` so
   * `supersede()` can mint within its own transaction for read/write
   * consistency.
   *
   * Memories have no tombstone table analogous to tasks' `deleted_task_ids`
   * (mt#2205) — the max is computed over live short ids only, so a deleted
   * memory's short id MAY be reissued to a new memory. Acceptable for v1
   * per the mt#2966 spec; a future task can add a `deleted_memory_short_ids`
   * tombstone table mirroring the tasks pattern if reuse proves undesirable.
   */
  private async nextMemoryShortId(db: MemoryServiceDb = this.deps.db): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const top = (await (db as any)
        .select({ shortId: memoriesTable.shortId })
        .from(memoriesTable)
        .where(sql`${memoriesTable.shortId} ~ '^mem#[0-9]+$'`)
        .orderBy(sql`(substring(${memoriesTable.shortId} from 5))::bigint DESC`)
        .limit(1)) as Array<{ shortId: string | null }>;
      const liveIds = Array.isArray(top) && top[0]?.shortId ? [top[0].shortId as string] : [];
      return nextShortId("mem", liveIds, []);
    } catch {
      // Fallback: this db doesn't support the full targeted-query chain
      // (an ad-hoc test fake, most likely) — use the unfiltered
      // single-column select + client-side fold instead.
    }

    const rows = (await db
      .select({ shortId: memoriesTable.shortId })
      .from(memoriesTable)) as Array<{
      shortId: string | null;
    }>;
    const liveIds = (Array.isArray(rows) ? rows : [])
      .map((r) => r.shortId)
      .filter((s): s is string => typeof s === "string");
    return nextShortId("mem", liveIds, []);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Insert a new memory row and compute + store its embedding.
   * Embedding failure is non-fatal: the row is still inserted and returned.
   *
   * Mints the next `mem#N` short id (mt#2966) and retries on a short_id
   * collision — the short-id proposal (SELECT max) and the INSERT are not
   * atomic, so a concurrent writer may claim the proposed id between the
   * two. The unique index on `short_id` turns that race into a clean
   * onConflictDoNothing no-op we detect and retry against, mirroring
   * `DrizzleAskRepository.create` (mt#2965) and
   * `MinskyTaskBackend.tryInsertTask` (mt#2205).
   */
  async create(rawInput: MemoryCreateInput): Promise<MemoryRecord> {
    // mt#3278: sanitize at the service boundary, not at each of the several
    // write sites below — a per-site fix is one refactor away from missing a
    // path, and the whole failure mode here is a write that fails permanently
    // and silently.
    const input: MemoryCreateInput = sanitizeForPostgresDeep(rawInput).value;
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const shortId = await this.nextMemoryShortId();
      const rows = await this.deps.db
        .insert(memoriesTable)
        .values({
          shortId,
          type: input.type,
          name: input.name,
          description: input.description,
          content: input.content,
          // mt#2663: last-line-of-defense default. `MemoryCreateInput.scope` is
          // typed as required, but callers that bypass TypeScript (raw MCP/CLI
          // args, `as any` casts) could still hand us `undefined`, which would
          // otherwise hit the `memories.scope` NOT NULL constraint at the DB.
          scope: input.scope ?? MEMORY_SCOPES.project,
          projectId: input.projectId ?? null,
          tags: input.tags ?? [],
          sourceAgentId: input.sourceAgentId ?? null,
          sourceSessionId: input.sourceSessionId ?? null,
          confidence: input.confidence ?? null,
          supersededBy: null,
          associations: input.associations ?? {},
        })
        .onConflictDoNothing({ target: memoriesTable.shortId })
        .returning();

      const row = rows?.[0] as Record<string, unknown> | undefined;
      if (row) {
        const record = rowToRecord(row);
        // Attempt to store embedding; degrade gracefully on failure.
        await this.tryStoreEmbedding(record.id, input.content);
        return record;
      }
      // short_id collision — another writer took it; loop and re-propose.
    }
    throw new Error(
      `Failed to allocate a unique memory short id after ${MAX_RETRIES} attempts. ` +
        "This indicates extremely high concurrent memory creation — please retry."
    );
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Fetch a single memory record by ID.
   *
   * Accepts either the canonical UUID primary key or a `mem#N` short id
   * (ADR-029). The short-id branch matters because `memories.id` is a
   * Postgres `uuid` column: passing a non-uuid string straight into
   * `eq(memoriesTable.id, ...)` does not return "not found", it raises
   * `invalid input syntax for type uuid` and echoes the whole failing
   * statement — which is how a `mem#N` route param surfaced as a raw driver
   * error in the cockpit rather than a miss (mt#3259; the same split
   * mt#3108 records on the `memory_update` surface).
   *
   * Note this is EXACT short-id / uuid resolution only. Unambiguous
   * uuid-PREFIX resolution (mt#2696) lives one layer up, in the command
   * adapter's `resolveMemoryIdInput`, which hands this method a full uuid —
   * unchanged by this method's new branch.
   *
   * Access tracking: bumps last_accessed_at and access_count non-blocking (fire-and-forget).
   */
  async get(id: string): Promise<MemoryRecord | null> {
    const record = await this.fetchById(id);
    if (!record) return null;
    this.bumpAccessCount([record.id]);
    return record;
  }

  /**
   * See {@link MemoryServiceSurface.getWithStaleness}.
   *
   * Routed through the SAME {@link annotateStaleness} pass `search()` uses, on a
   * one-element result list, rather than a parallel implementation. Two consequences that
   * are the point rather than an accident of reuse:
   *
   * - **Every trigger `search()` has, this has** — including trigger 2's measurement decay
   *   (mt#4452), which `annotateStaleness` folds in via `combineStaleness`. A third trigger
   *   added later lands on both surfaces at once, which is the property that makes
   *   "`memory_get` returns the same annotation `memory_search` does" true by construction
   *   instead of by two implementations someone has to keep in step.
   * - **The lookup cost is the same shape, not a new one.** `annotateStaleness` returns
   *   before issuing any query when the record declares no refs, so an ordinary fetch costs
   *   zero extra queries; only a record that actually names a tracking task pays for one.
   *   That matters here because `get` sits on far hotter paths than `search`.
   */
  async getWithStaleness(id: string): Promise<MemoryReadResult | null> {
    const record = await this.get(id);
    if (!record) return null;

    // `score: 0` is a placeholder for a shape that requires one — a fetch-by-id has no
    // query to be relevant to, and nothing downstream of `annotateStaleness` reads it.
    const results: MemorySearchResult[] = [{ record, score: 0 }];
    await this.annotateStaleness(results);

    const staleness = results[0]?.staleness;
    return staleness === undefined ? { record } : { record, staleness };
  }

  /**
   * Read a record WITHOUT bumping `last_accessed_at` / `access_count`.
   *
   * For a caller that reads a record in order to WRITE it — `memory.patch`
   * (mt#3602) reads the current content to splice one section — the read is
   * bookkeeping for the write, not a read OF the record by a consumer. This is
   * the same distinction `getMemoryRefSummary` above draws for `refs.status`,
   * and the same reason: counting maintenance reads inflates the access stats
   * that surface memory relevance.
   *
   * That inflation is not cosmetic here. `access_count` is what marks a
   * long-lived family root as heavily-cited, and appending an entry to such a
   * root is precisely the operation `memory.patch` exists to make cheap — so
   * counting each append as a read would let routine maintenance manufacture
   * the very signal used to judge which records matter.
   */
  async getWithoutAccessTracking(id: string): Promise<MemoryRecord | null> {
    return this.fetchById(id);
  }

  private async fetchById(id: string): Promise<MemoryRecord | null> {
    const where = memoryIdWhere(id);
    // Neither a uuid nor a `mem#N` short id — a genuine miss, not a query.
    // Returning null here is what keeps a malformed route param from
    // reaching the driver as a uuid cast.
    if (!where) return null;

    const rows = await this.deps.db.select().from(memoriesTable).where(where);

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }

  /**
   * List memory records with ordering, limiting, offsetting and tag
   * filtering applied IN SQL (mt#4761) — previously this issued
   * `db.select().from(memoriesTable)` with no `ORDER BY` and no `LIMIT` on
   * every path except `filter.stale`, so rows arrived in Postgres heap order
   * and every caller fetched the entire matching set.
   *
   * Default order is `created desc` — a stable, meaningful default rather
   * than heap order — UNLESS `filter.stale` is set, in which case the
   * pre-existing `lastAccessedAt ASC NULLS FIRST` order is preserved exactly
   * (the stale/health-widget browsing mode ignores `sort`/`dir`).
   *
   * Default limit is `DEFAULT_LIST_CAP` (packages/domain/src/utils/list-pagination.ts,
   * mt#2817) when `filter.limit` is not given — the "loud caps" convention is
   * EXTENDED, not replaced: what changes is WHERE the cap applies (SQL
   * `LIMIT`, not an in-memory `items.slice`).
   *
   * This method intentionally keeps returning a plain `MemoryRecord[]` (not a
   * `{records, meta}` shape) rather than folding `count()` in directly —
   * FOUR existing consumers destructure its result as a bare array and are
   * outside this task's `## Scope`: `src/mcp/middleware/memory-bundle.ts`
   * (the MCP `instructions` bundle composer), the `MemoryServiceSurface` fake
   * in `src/cockpit/widgets/memories-project-scope.test.ts`, and the
   * `MemoryServiceDb` fake in `tests/domain/project-scope-acceptance.test.ts`
   * (a 4th, `tests/domain/memory/memory-service.test.ts`, drives this method
   * through a similar fake). Changing the shape here would break all of them.
   * A caller wanting the page AND an accurate total in one call — the actual
   * mt#4761 success criterion, which is about the CALLER not making a second
   * round trip, not about SQL statement count — should call `listWithMeta()`
   * instead, which wraps this method and `count()` together.
   */
  async list(filter?: MemoryListFilter): Promise<MemoryRecord[]> {
    const conditions = buildListConditions(filter);

    const baseQuery = this.deps.db.select().from(memoriesTable);
    const filteredQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

    // When stale filter is active, sort by lastAccessedAt ASC NULLS FIRST so the
    // oldest/never-accessed records appear first — unchanged from pre-mt#4761
    // behavior, and NOT overridable via `sort`/`dir`.
    const orderExpr = filter?.stale
      ? sql`${memoriesTable.lastAccessedAt} ASC NULLS FIRST`
      : resolveListOrderBy(filter?.sort, filter?.dir);

    const limit =
      typeof filter?.limit === "number" && filter.limit > 0 ? filter.limit : DEFAULT_LIST_CAP;
    const offset = typeof filter?.offset === "number" && filter.offset > 0 ? filter.offset : 0;

    const rows = await filteredQuery.orderBy(orderExpr).limit(limit).offset(offset);

    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  /**
   * True count of memories matching `filter`, ignoring `limit`/`offset`/
   * `sort`/`dir` (mt#4761). Exists so a paginated caller (the cockpit widget,
   * the `memory.list` command) can report an accurate `{returned, total,
   * truncated}` triple without materializing every matching row — `list()`
   * deliberately stays capped, so its own array length cannot answer "how
   * many rows actually match."
   *
   * Applies the EXACT same predicates as `list()` via the shared
   * `buildListConditions` — see that function's doc comment for why drift
   * between the two would be a correctness bug, not a style issue.
   */
  async count(filter?: MemoryListFilter): Promise<number> {
    const conditions = buildListConditions(filter);
    const baseQuery = this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoriesTable);
    const filteredQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    const rows = (await filteredQuery) as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  /**
   * `list()` + `count()` in one caller-facing call (mt#4761, PR #3488 R1 BLOCKING) —
   * see the `MemoryServiceSurface.listWithMeta` doc comment for why this exists
   * alongside `list()` rather than changing `list()`'s own return shape.
   *
   * A paired count query, deliberately: a windowed `count(*) over ()` folded into the
   * `list()` query would return NO row (and so no count at all) on a zero-row page,
   * which a separate `count()` call does not have.
   */
  async listWithMeta(
    filter?: MemoryListFilter
  ): Promise<{ records: MemoryRecord[]; meta: ListTruncationMetadata }> {
    const records = await this.list(filter);
    const total = await this.count(filter);
    return { records, meta: computeListTruncation(total, records.length) };
  }

  /**
   * Aggregate counts for the memories-stats cockpit widget (mt#4761),
   * computed via SQL aggregates rather than loading every matching row with
   * full `content` to compute five numbers client-side (the pre-mt#4761
   * behavior: `memSvc.list({projectScope})` fetched all ~1,338 rows for this).
   *
   * `filter` is typically just `{ projectScope }` — the widget does not
   * apply `excludeSuperseded` here (it wants totals INCLUDING superseded
   * records, matching the pre-existing widget behavior).
   */
  async getListStats(filter?: MemoryListFilter): Promise<{
    total: number;
    supersededCount: number;
    byType: Record<MemoryType, number>;
    recentCount: number;
    topAccessed: Array<{ id: string; name: string; accessCount: number }>;
  }> {
    const conditions = buildListConditions(filter);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const typeCountSql = (type: MemoryType) =>
      sql<number>`count(*) filter (where ${memoriesTable.type} = ${type})::int`;

    const aggQuery = this.deps.db
      .select({
        total: sql<number>`count(*)::int`,
        supersededCount: sql<number>`count(*) filter (where ${memoriesTable.supersededBy} is not null)::int`,
        // mt#4761: interpolate as an ISO string, not the Date object directly.
        // A raw `sql` template's parameter binding does NOT go through the
        // same type-aware serialization `gte()`/`lte()` apply in
        // buildListConditions — postgres.js chokes on a bare `Date` here
        // ("argument must be of type string ... Received an instance of
        // Date"), caught live via this task's own verification.
        recentCount: sql<number>`count(*) filter (where ${memoriesTable.createdAt} >= ${sevenDaysAgo.toISOString()})::int`,
        userCount: typeCountSql("user"),
        feedbackCount: typeCountSql("feedback"),
        projectCount: typeCountSql("project"),
        referenceCount: typeCountSql("reference"),
      })
      .from(memoriesTable);
    const aggRows = (await (whereClause ? aggQuery.where(whereClause) : aggQuery)) as Array<{
      total: number;
      supersededCount: number;
      recentCount: number;
      userCount: number;
      feedbackCount: number;
      projectCount: number;
      referenceCount: number;
    }>;
    const agg = aggRows[0];

    const accessedCondition = gte(memoriesTable.accessCount, 1);
    const topQuery = this.deps.db
      .select({
        id: memoriesTable.id,
        name: memoriesTable.name,
        accessCount: memoriesTable.accessCount,
      })
      .from(memoriesTable)
      .where(whereClause ? and(whereClause, accessedCondition) : accessedCondition)
      .orderBy(desc(memoriesTable.accessCount))
      .limit(3);
    const topRows = (await topQuery) as Array<{ id: string; name: string; accessCount: number }>;

    return {
      total: agg?.total ?? 0,
      supersededCount: agg?.supersededCount ?? 0,
      byType: {
        user: agg?.userCount ?? 0,
        feedback: agg?.feedbackCount ?? 0,
        project: agg?.projectCount ?? 0,
        reference: agg?.referenceCount ?? 0,
      },
      recentCount: agg?.recentCount ?? 0,
      topAccessed: topRows.map((r) => ({ id: r.id, name: r.name, accessCount: r.accessCount })),
    };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(id: string, rawInput: MemoryUpdateInput): Promise<MemoryRecord | null> {
    // mt#3278 — see `create` above for why this is at the boundary.
    const input: MemoryUpdateInput = sanitizeForPostgresDeep(rawInput).value;
    const where = memoryIdWhere(id);
    // Neither a uuid nor a `mem#N` short id — a miss, not a query (mt#3108).
    if (!where) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (input.type !== undefined) updateData["type"] = input.type;
    if (input.name !== undefined) updateData["name"] = input.name;
    if (input.description !== undefined) updateData["description"] = input.description;
    if (input.content !== undefined) updateData["content"] = input.content;
    if (input.scope !== undefined) updateData["scope"] = input.scope;
    if ("projectId" in input) updateData["projectId"] = input.projectId ?? null;
    if (input.tags !== undefined) updateData["tags"] = input.tags;
    if ("sourceAgentId" in input) updateData["sourceAgentId"] = input.sourceAgentId ?? null;
    if ("sourceSessionId" in input) updateData["sourceSessionId"] = input.sourceSessionId ?? null;
    if ("confidence" in input) updateData["confidence"] = input.confidence ?? null;

    if (input.associations !== undefined) {
      const entries = Object.entries(input.associations);
      const toMerge = Object.fromEntries(entries.filter(([, v]) => v.length > 0));
      const toRemove = entries.filter(([, v]) => v.length === 0).map(([k]) => k);

      let expr = sql`${memoriesTable.associations} || ${JSON.stringify(toMerge)}::jsonb`;
      for (const key of toRemove) {
        expr = sql`(${expr}) - ${key}`;
      }
      updateData["associations"] = expr;
    }

    const rows = await this.deps.db.update(memoriesTable).set(updateData).where(where).returning();

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    const record = rowToRecord(row);

    // Re-embed if content changed.
    if (input.content !== undefined) {
      await this.tryStoreEmbedding(record.id, input.content);
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async delete(id: string): Promise<void> {
    const where = memoryIdWhere(id);
    // A malformed id deletes nothing rather than raising a uuid cast (mt#3108).
    if (!where) return;

    // Delete the row and read back WHICH row went, because the vector store is
    // keyed by the canonical uuid — never by a `mem#N` alias. Passing the
    // caller's raw input to `vectorStorage.delete` would silently orphan the
    // embedding whenever a short id was used: the row deletion succeeds, the
    // vector deletion matches nothing, and neither reports a problem
    // (PR #2348 R1). That is the exact "a failure that looks like success"
    // shape mem#728 describes, and it is a regression this task would have
    // introduced — before short ids resolved here, the row deletion itself
    // raised a cast error, so the vector delete never ran on a bad key.
    const deleted = (await this.deps.db.delete(memoriesTable).where(where).returning()) as Record<
      string,
      unknown
    >[];

    const deletedId = deleted?.[0]?.["id"];
    // Nothing matched — no embedding to remove, and no id to remove it by.
    if (deletedId === undefined || deletedId === null) return;

    const canonicalId = String(deletedId);
    await this.deps.vectorStorage.delete(canonicalId).catch((err: unknown) => {
      log.warn("[memory.delete] Failed to delete embedding", { id: canonicalId, err });
    });
  }

  // -------------------------------------------------------------------------
  // Search (semantic)
  // -------------------------------------------------------------------------

  /**
   * Compute a query embedding, then search the vector store.
   * Returns degraded={true} when the embedding service is unavailable.
   */
  async search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResponse> {
    let queryVector: number[];

    try {
      queryVector = await this.deps.embeddingService.generateEmbedding(query);
    } catch (err) {
      log.warn("[memory.search] Embedding service unavailable; returning empty results", { err });
      return { results: [], backend: "none", degraded: true };
    }

    const searchResults = await this.deps.vectorStorage.search(queryVector, {
      limit: opts?.limit ?? 10,
      threshold: opts?.threshold,
    });

    if (searchResults.length === 0) {
      return { results: [], backend: "embeddings", degraded: false };
    }

    // Fetch the actual memory records for the returned IDs.
    const ids = searchResults.map((r) => r.id);

    // Build a filter query for the IDs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [inArray(memoriesTable.id, ids)];

    // Apply optional domain filters post-hoc.
    if (opts?.filter?.type) {
      conditions.push(eq(memoriesTable.type, opts.filter.type));
    }
    if (opts?.filter?.scope) {
      conditions.push(eq(memoriesTable.scope, opts.filter.scope));
    }
    // projectScope takes precedence over projectId when both are set (ADR-021, mt#2416)
    if (opts?.filter?.projectScope && !isAllProjects(opts.filter.projectScope)) {
      conditions.push(scopedToProject(opts.filter.projectScope));
    } else if (opts?.filter?.projectId) {
      conditions.push(eq(memoriesTable.projectId, opts.filter.projectId));
    }
    if (opts?.filter?.excludeSuperseded) {
      conditions.push(isNull(memoriesTable.supersededBy));
    }

    const rows = (await this.deps.db
      .select()
      .from(memoriesTable)
      .where(and(...conditions))) as Record<string, unknown>[];

    // Map rows by ID for O(1) lookup, preserving vector-score ordering.
    const rowById = new Map(rows.map((r) => [String(r["id"]), r]));

    const results: MemorySearchResult[] = [];
    for (const sr of searchResults) {
      const row = rowById.get(sr.id);
      if (row) {
        results.push({ record: rowToRecord(row), score: sr.score });
      }
    }

    // Read-time staleness annotation (mt#1709). Mutates only the response, never the row.
    await this.annotateStaleness(results);

    // Access tracking: bump non-blocking (fire-and-forget).
    this.bumpAccessCount(results.map((r) => r.record.id));

    return { results, backend: "embeddings", degraded: false };
  }

  /**
   * Attach a staleness verdict to each result whose record declares a retirement clause
   * (mt#1709). Mutates `results` in place; the stored rows are untouched.
   *
   * ONE lookup for the whole result set, not one per result: the refs from every record are
   * unioned before the single `taskStatusLookup` call, so a K=10 search costs one query
   * rather than ten (`efficient-database-queries`).
   *
   * Fail-open, and deliberately so — a search that returns unannotated results is strictly
   * better than a search that throws. But note the asymmetry this creates: a lookup failure
   * is indistinguishable from "no memory declared a clause", both being silent. That is
   * acceptable HERE because the annotation is additive; it would not be acceptable for a
   * check whose silence reads as a pass, which is exactly why `computeStaleness` reports
   * `unresolved` separately from `current` one level down.
   */
  private async annotateStaleness(results: MemorySearchResult[]): Promise<void> {
    const lookup = this.deps.taskStatusLookup;
    if (!lookup || results.length === 0) return;

    const perResult = results.map((r) => extractTrackingTaskRefs(r.record));
    // Trigger 3 (mt#4743). Extracted here, beside trigger 1, so both share ONE status
    // lookup — its refs are task ids of exactly the same kind, and unioning them keeps the
    // "one query per search" property the docblock below claims rather than adding a second.
    const perResultAssertions = results.map((r) => extractTaskStateAssertions(r.record));
    const allRefs = [
      ...new Set([
        ...perResult.flatMap((p) => p.refs),
        ...perResultAssertions.flatMap((a) => assertedTaskIds(a)),
      ]),
    ];
    if (allRefs.length === 0) return;

    let statuses: ReadonlyMap<string, string | undefined>;
    try {
      statuses = await lookup(allRefs);
    } catch (err) {
      log.warn("[memory.search] Staleness lookup failed; returning unannotated results", { err });
      return;
    }

    for (const [i, result] of results.entries()) {
      const extracted = perResult[i];
      if (!extracted) continue;
      const staleness = computeStaleness(extracted.refs, extracted.source, statuses);
      if (staleness) result.staleness = staleness;

      // Trigger 3 folds on top, against the SAME `statuses` map — no extra query. It can
      // promote a `current` verdict to `stale`, but only when a drifted assertion names a
      // task that has since gone terminal; see `combineTaskStateDrift`.
      const assertions = perResultAssertions[i];
      if (assertions && assertions.length > 0) {
        const combined = combineTaskStateDrift(
          result.staleness,
          computeTaskStateDrift(assertions, statuses)
        );
        if (combined) result.staleness = combined;
      }
    }

    // mt#4452: trigger 2 folds in on top, and can promote a `current` verdict to `stale` —
    // an open tracking task says nothing about whether the record's numbers still hold.
    await this.annotateMeasurementDecay(results);

    // AT4: a memory naming a task id that does not resolve is a graceful no-annotation AND a
    // logged warning — the record is citing something the task graph cannot account for, which
    // is worth knowing even though it must not block or annotate the search. The decision of
    // what to warn about is a pure function so it can be tested without asserting on a logger
    // the test harness silences.
    const unresolved = collectUnresolvedRefs(
      results.map((r) => ({ memoryId: r.record.id, staleness: r.staleness }))
    );
    if (unresolved.length > 0) {
      log.warn("[memory.search] Memory cites tracking task ids that could not be resolved", {
        unresolved,
      });
    }
  }

  /**
   * Fold measurement-decay findings into each result's verdict (mt#4452, trigger 2).
   *
   * Runs AFTER trigger 1 so it can combine with (and promote) that verdict.
   *
   * Unlike trigger 1's single union'd lookup, this issues one query PER RECORD carrying a
   * dated measurement, because each has its own `since` date and its own subsystem set —
   * there is no single query covering them. That is bounded in practice rather than in
   * principle: measured over the live corpus at planning time, 28 of 1215 records (2.30%)
   * carry a dated measurement at all, and a search page is at most `limit` records, so a K=10
   * page issues at most 10 and typically zero. If that ratio moves, batch by unioning the
   * subsystems and filtering per-record in memory.
   *
   * Fail-open per record: one record's lookup failing must not cost the whole page its
   * annotations, nor the search its results.
   */
  private async annotateMeasurementDecay(results: MemorySearchResult[]): Promise<void> {
    const lookup = this.deps.interveningTaskLookup;
    if (!lookup || results.length === 0) return;

    const now = new Date();
    // Hard ceiling on lookups per page, so the per-record shape cannot degrade into an
    // unbounded N+1 if the corpus's measurement density rises (PR #3271 R1, non-blocking).
    // Measured at 2.30% of records today, so this is never reached in practice — which is
    // exactly why it is a cap rather than a comment: the reasoning that makes per-record
    // acceptable is a property of the DATA, and data moves.
    let lookupsRemaining = MAX_MEASUREMENT_LOOKUPS_PER_PAGE;

    for (const result of results) {
      const measurement = extractMeasurement(result.record);
      if (!measurement) continue;

      // A dated measurement whose subsystem cannot be resolved is UNRESOLVED, not silent —
      // we found something worth checking and could not check it. Renders nothing either way,
      // but stays distinguishable in the structured field, per the same discipline
      // `computeStaleness` applies to an unknown task id.
      if (measurement.subsystems.length === 0) {
        result.staleness = result.staleness ?? {
          outcome: "unresolved",
          source: "text",
          completedTasks: [],
          unresolvedTasks: [],
        };
        continue;
      }

      if (lookupsRemaining <= 0) {
        log.warn("[memory.search] Measurement-decay lookup cap reached; page partially annotated", {
          cap: MAX_MEASUREMENT_LOOKUPS_PER_PAGE,
        });
        break;
      }

      try {
        lookupsRemaining--;
        const intervening = await lookup(
          measurement.subsystems,
          new Date(`${measurement.measuredOn}T00:00:00Z`)
        );
        const decay = computeMeasurementDecay(measurement, intervening, now);
        const combined = combineStaleness(result.staleness, decay);
        if (combined) result.staleness = combined;
      } catch (err) {
        log.warn("[memory.search] Intervening-task lookup failed for one record", {
          memoryId: result.record.id,
          err,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Similar (find neighbors of an existing memory)
  // -------------------------------------------------------------------------

  async similar(
    id: string,
    opts?: Pick<MemorySearchOptions, "limit" | "threshold"> & {
      projectScope?: import("../project/scope").ProjectScope;
    }
  ): Promise<MemorySearchResult[]> {
    // Note: this.get(id) below bumps the source record's access_count via
    // bumpAccessCount. That is intentional — a similar(id) call counts as an
    // access of the source as well as the neighbors. If this turns out to be
    // wrong, revisit the bump semantics at that point.
    const embeddingMeta = await this.deps.vectorStorage.getMetadata?.(id);
    if (!embeddingMeta) {
      return [];
    }

    // Re-fetch the record's own content to get its vector.
    const record = await this.get(id);
    if (!record) return [];

    let vector: number[];
    try {
      vector = await this.deps.embeddingService.generateEmbedding(record.content);
    } catch {
      return [];
    }

    const searchResults = await this.deps.vectorStorage.search(vector, {
      limit: (opts?.limit ?? 10) + 1, // +1 to account for self
      threshold: opts?.threshold,
    });

    // Exclude self from results.
    const filtered = searchResults.filter((r) => r.id !== id).slice(0, opts?.limit ?? 10);

    if (filtered.length === 0) return [];

    const ids = filtered.map((r) => r.id);

    // mt#2939: cross-check against the live `memories` table's project scope, the same
    // way search()/list() already do (ADR-021, mt#2416). A uuid projectScope adds the
    // shared `scopedToProject` predicate; ALL_PROJECTS (or omitted) adds none — any
    // candidate whose row falls outside the scope simply isn't in `rows`, so it's
    // dropped below by rowById.get(sr.id) returning undefined (same "missing row =>
    // drop" pattern search() already relies on for excludeSuperseded/type/scope filters).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [inArray(memoriesTable.id, ids)];
    if (opts?.projectScope && !isAllProjects(opts.projectScope)) {
      conditions.push(scopedToProject(opts.projectScope));
    }

    const rows = (await this.deps.db
      .select()
      .from(memoriesTable)
      .where(and(...conditions))) as Record<string, unknown>[];

    const rowById = new Map(rows.map((r) => [String(r["id"]), r]));

    const similarResults = filtered
      .map((sr) => {
        const row = rowById.get(sr.id);
        return row ? { record: rowToRecord(row), score: sr.score } : null;
      })
      .filter((r): r is MemorySearchResult => r !== null);

    // Access tracking: bump non-blocking (fire-and-forget).
    this.bumpAccessCount(similarResults.map((r) => r.record.id));

    return similarResults;
  }

  // -------------------------------------------------------------------------
  // Supersede
  // -------------------------------------------------------------------------

  /**
   * Atomically create a replacement memory and mark the old one as superseded.
   * The old memory remains in the database but is excluded from
   * `list({ excludeSuperseded: true })`.
   *
   * Mints a `mem#N` short id (mt#2966) for the replacement row, computed
   * within the same transaction (`tx`, not `this.deps.db`) for read/write
   * consistency. Unlike `create()`, this is a single-attempt mint with no
   * onConflictDoNothing/retry loop — supersede is a much lower-frequency
   * path than create, so the same collision-retry ceremony was judged not
   * worth the added transaction complexity for v1; a genuine collision here
   * (extremely rare) surfaces as a raw unique-constraint error, matching
   * pre-mt#2966 behavior for any other constraint violation on this insert.
   */
  async supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    // Resolve the old id's shape BEFORE opening the transaction (mt#3108).
    // Unlike update/delete this cannot return a not-found value — the
    // signature promises a record pair — so a malformed id throws here rather
    // than inserting the replacement and only then failing the old-row update
    // on a uuid cast, which would roll back the insert and surface a raw SQL
    // dump instead of naming the problem.
    const oldWhere = memoryIdWhere(oldId);
    if (!oldWhere) {
      throw new Error(`Invalid memory id "${oldId}": expected a full uuid or a mem#N short id.`);
    }

    const { oldRecord, newRecord } = await this.deps.db.transaction(async (tx: MemoryServiceDb) => {
      const shortId = await this.nextMemoryShortId(tx);
      // Insert new memory inside the transaction.
      const newRows = await tx
        .insert(memoriesTable)
        .values({
          shortId,
          type: newInput.type,
          name: newInput.name,
          description: newInput.description,
          content: newInput.content,
          // mt#2663: same last-line-of-defense default as create() — an
          // untyped caller passing undefined would otherwise hit the
          // `memories.scope` NOT NULL constraint at the DB.
          scope: newInput.scope ?? MEMORY_SCOPES.project,
          projectId: newInput.projectId ?? null,
          tags: newInput.tags ?? [],
          sourceAgentId: newInput.sourceAgentId ?? null,
          sourceSessionId: newInput.sourceSessionId ?? null,
          confidence: newInput.confidence ?? null,
          supersededBy: null,
        })
        .returning();

      const replacement = rowToRecord(newRows[0] as Record<string, unknown>);

      // Read the old memory's current metadata so we can append rather than overwrite.
      const oldRowsBefore = await tx.select().from(memoriesTable).where(oldWhere);
      const oldBefore = oldRowsBefore[0] as Record<string, unknown> | undefined;
      // Fail loudly and by name when the old memory does not exist. Without
      // this the missing row surfaces further down as `rowToRecord(undefined)`
      // reading properties of undefined — an error whose text says nothing
      // about the actual problem (PR #2348 R1). The transaction rolls back, so
      // the replacement inserted above is not left behind.
      if (!oldBefore) {
        throw new Error(`Memory not found: "${oldId}" — nothing to supersede.`);
      }
      const existingMetadata =
        (oldBefore?.["metadata"] as Record<string, unknown> | null | undefined) ?? {};
      const mergedMetadata = {
        ...existingMetadata,
        supersession_reason: reason ?? null,
        superseded_at: new Date().toISOString(),
      };

      // Mark the old memory as superseded and record the reason in metadata.
      const oldRows = await tx
        .update(memoriesTable)
        .set({
          supersededBy: replacement.id,
          metadata: mergedMetadata,
          updatedAt: new Date(),
        })
        .where(oldWhere)
        .returning();

      return {
        newRecord: replacement,
        oldRecord: rowToRecord(oldRows[0] as Record<string, unknown>),
      };
    });

    // Compute embedding for the new memory outside the transaction.
    await this.tryStoreEmbedding(newRecord.id, newInput.content);

    return { old: oldRecord, replacement: newRecord };
  }

  // -------------------------------------------------------------------------
  // Lineage
  // -------------------------------------------------------------------------

  /**
   * Walk the supersession chain for a given memory ID and return the ordered chain
   * from oldest ancestor to newest descendant.
   *
   * Algorithm:
   * 1. Load the starting record.
   * 2. Walk BACKWARD: find records A where A.supersededBy === current.id (predecessors).
   * 3. Walk FORWARD: follow current.supersededBy to find newer replacements.
   * 4. Return chain ordered [oldest ancestor, ..., newest descendant].
   * 5. Cycle guard: track visited IDs; break + set truncated=true on repeat.
   * 6. Max depth: 100 iterations total to prevent runaway.
   */
  async lineage(id: string): Promise<{ chain: MemoryRecord[]; truncated: boolean }> {
    const MAX_DEPTH = 100;
    const visited = new Set<string>();
    let truncated = false;

    // Load the starting record.
    const start = await this.getById(id);
    if (!start) return { chain: [], truncated: false };

    // Walk BACKWARD to find oldest ancestor.
    const ancestors: MemoryRecord[] = [];
    let current = start;
    let depth = 0;
    while (depth < MAX_DEPTH) {
      if (visited.has(current.id)) {
        truncated = true;
        break;
      }
      visited.add(current.id);

      // Find the predecessor: a record whose supersededBy points to current.id
      const predecessorRows = (await this.deps.db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.supersededBy, current.id))) as Record<string, unknown>[];

      if (predecessorRows.length === 0) break;
      const predecessor = rowToRecord(predecessorRows[0] as Record<string, unknown>);
      ancestors.push(predecessor);
      current = predecessor;
      depth++;
    }

    if (depth >= MAX_DEPTH) truncated = true;

    // ancestors is [direct predecessor, ..., oldest ancestor] — reverse to get [oldest, ...]
    ancestors.reverse();

    // Walk FORWARD from start to find newer replacements.
    const descendants: MemoryRecord[] = [];
    current = start;
    depth = 0;
    while (depth < MAX_DEPTH && current.supersededBy) {
      if (visited.has(current.supersededBy)) {
        truncated = true;
        break;
      }
      visited.add(current.supersededBy);

      const nextRecord = await this.getById(current.supersededBy);
      if (!nextRecord) break;
      descendants.push(nextRecord);
      current = nextRecord;
      depth++;
    }

    if (depth >= MAX_DEPTH) truncated = true;

    const chain = [...ancestors, start, ...descendants];
    return { chain, truncated };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a record by ID without triggering access tracking (internal helper).
   */
  private async getById(id: string): Promise<MemoryRecord | null> {
    const where = memoryIdWhere(id);
    if (!where) return null;
    const rows = await this.deps.db.select().from(memoriesTable).where(where);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Fire-and-forget access tracking bump.
   * Updates last_accessed_at = NOW() and access_count += 1 for the given IDs.
   * Non-blocking: search/get latency is not gated on this update.
   * Errors are logged as warnings but do not propagate to callers.
   */
  private bumpAccessCount(ids: string[]): void {
    if (ids.length === 0) return;
    // Wrap in Promise.resolve so we can attach .catch even if the underlying
    // query-builder doesn't return a native Promise (e.g., fake DBs in tests
    // that model the Drizzle chain with plain objects).
    Promise.resolve(
      this.deps.db
        .update(memoriesTable)
        .set({
          lastAccessedAt: new Date(),
          accessCount: sql`${memoriesTable.accessCount} + 1`,
        })
        .where(inArray(memoriesTable.id, ids))
    ).catch((err: unknown) => {
      log.warn("[memory] access tracking bump failed", { err });
    });
  }

  private async tryStoreEmbedding(id: string, content: string): Promise<void> {
    try {
      const vector = await this.deps.embeddingService.generateEmbedding(content);
      await this.deps.vectorStorage.store(id, vector, { memoryId: id });
    } catch (err) {
      log.warn("[memory.create] Embedding failed; record stored without vector", { id, err });
    }
  }
}
