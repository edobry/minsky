import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import { describeWidgetDegradedReason } from "../db-providers";
import type {
  MemoryRecord,
  MemoryType,
  MemoryScope,
  MemoryListFilter,
  MemoryListSortField,
  MemoryListSortDirection,
  MemorySummaryRecord,
} from "@minsky/domain/memory/types";
import { toMemorySummary } from "@minsky/domain/memory/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

/**
 * Widget-specific row shape: the shared `MemorySummaryRecord` projection plus
 * `shortId` (mt#4761 AT2 needs the `mem#N` short id to verify default-sort
 * ordering against the DB's max short id — `toMemorySummary`'s shared shape
 * intentionally excludes it, since it must stay byte-identical to the
 * `memory.list summary:true` command output pinned by
 * `memory-commands.test.ts`).
 */
export type MemoriesListRow = MemorySummaryRecord & { shortId?: string };

export interface MemoriesListPayload {
  records: MemoriesListRow[];
  total: number;
}

/** Default page size (mt#4761) — distinct from the domain's DEFAULT_LIST_CAP (500). */
const DEFAULT_PAGE_SIZE = 50;

const SORT_FIELDS: readonly MemoryListSortField[] = [
  "created",
  "updated",
  "lastAccessed",
  "accessCount",
  "shortId",
  "name",
];

function parseSort(value: string | undefined): MemoryListSortField | undefined {
  return SORT_FIELDS.includes(value as MemoryListSortField)
    ? (value as MemoryListSortField)
    : undefined;
}

function parseDir(value: string | undefined): MemoryListSortDirection | undefined {
  return value === "asc" || value === "desc" ? value : undefined;
}

/**
 * Parse the `tags` query param (mt#4761). The widget-dispatch route
 * (`src/cockpit/routes/health.ts`'s `GET /api/widget/:id/data` handler)
 * builds `ctx.query` as `Record<string, string>` and SILENTLY DROPS any key
 * whose raw value isn't a string — which is exactly what a repeated
 * `?tags=a&tags=b` query becomes under the framework's default array
 * parsing. A single string value can still carry multiple tags via a
 * comma-separated list (`?tags=a,b`), which is the format this widget
 * actually supports end-to-end; fixing the dispatcher to preserve
 * multi-value query params is out of this task's scope (`health.ts` is not
 * an in-scope file).
 */
function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/**
 * Parse a NON-NEGATIVE integer — zero is a valid value here.
 *
 * Only `offset` may legitimately be 0 (it is the first page). Everything else
 * this widget parses is a count or a day-threshold, where 0 is meaningless at
 * best and wrong at worst — see {@link parsePositiveInt}.
 */
export function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Parse a STRICTLY positive integer, rejecting 0 and negatives (PR #3508 R1).
 *
 * This function existed under this name accepting `n >= 0`, which is what its
 * callers reasonably assumed it did not do. The consequence is worst for the
 * day-thresholds: `coldDays=0` becomes `interval '0 days'`, so every
 * ever-read record matches and the cold worklist silently widens to "all
 * read" — a plausible number, not an error. `stalenessDays=0` does the same to
 * the stale filter, which predates this PR.
 *
 * It also matters for `limit`: a page of 0 rows is an empty table, again with
 * nothing to indicate the parameter was the cause.
 *
 * The strict-positive guard in `memories-curation.ts` was written correctly and
 * this one was not, so the tile's count and the table it links to could
 * disagree — which is exactly the divergence the two-path design has to avoid.
 *
 * Uses `Number` + `Number.isInteger`, not `parseInt`, and that is the second
 * half of the same fix: `parseInt("7.5", 10)` returns 7, so a fractional
 * `coldDays` silently became 7 days HERE while the curation widget rejected it
 * and fell back to 14 — the tile and its table describing different
 * thresholds. Caught by the cross-widget agreement test, not by the review.
 */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Factory: returns a WidgetModule backed by the given memory-service getter.
 *
 * @param getMemService  Async factory returning the shared MemoryService (or
 *   null when persistence isn't SQL-capable). Called on each fetch(); the
 *   default production export below points at the real
 *   `getSharedMemoryService()` singleton (mt#4727, test seam mirroring
 *   `task-list.ts`'s `createTaskListWidget` factory pattern — enables a
 *   two-project-fixture test without touching the real DB-backed singleton).
 * @param getProjectScopeDb  Optional test seam (mt#4727, mirrors
 *   `task-list.ts`'s mt#3016 `getDb` seam): overrides
 *   `resolveCockpitProjectScope`'s own db-fetch. Production callers never
 *   set this.
 */
export function createMemoriesListWidget(
  getMemService: () => Promise<MemoryServiceSurface | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-list",
    title: "Memories — List",
    updateMode: { type: "polling", intervalMs: 30_000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const memSvc = await getMemService();
        if (!memSvc) {
          return {
            state: "degraded",
            reason: "Memory service unavailable — DB not connected",
          };
        }

        const { query } = ctx;
        const type = query?.type as MemoryType | undefined;
        const scope = query?.scope as MemoryScope | undefined;
        const excludeSuperseded = query?.excludeSuperseded === "true";
        const limit = parsePositiveInt(query?.limit) ?? DEFAULT_PAGE_SIZE;
        // The ONE caller for which 0 is a real value — it is the first page.
        const offset = parseNonNegativeInt(query?.offset) ?? 0;
        const stale = query?.stale === "true";
        const stalenessDays = parsePositiveInt(query?.stalenessDays);
        // mt#4767 curation worklists. `cold` is NOT `stale` with a different
        // threshold: `stale` unions never-read with read-but-old, so it can
        // never render the two as separate lists — see MemoryListFilter's
        // field docs for the measurement (252 vs 251 at the 90-day default).
        const untagged = query?.untagged === "true";
        const neverAccessed = query?.neverAccessed === "true";
        const cold = query?.cold === "true";
        const coldDays = parsePositiveInt(query?.coldDays);
        const onlySuperseded = query?.onlySuperseded === "true";
        const association =
          query?.associationType && query?.associationTarget
            ? { type: query.associationType, targetId: query.associationTarget }
            : undefined;

        // Project scope (mt#4727): ?project=<slug> resolved to a project uuid,
        // defaulting to ALL_PROJECTS when omitted/"all" — same resolution
        // rules as every other cockpit project-scoped read (mt#2418 pattern,
        // task-list.ts:91-93). resolveCockpitProjectScope owns its own
        // db-fetch and never throws (fail-open — PR #2056 R1), so a scoping
        // problem can never take this widget down.
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(query?.project, {
          getDb: getProjectScopeDb,
        });

        // mt#4761: sort/dir/limit/offset/tags/nameContains applied IN SQL by
        // MemoryService.list() — plus the four filters (stale/stalenessDays/
        // association/since/until) that already existed on MemoryListFilter
        // but were never reachable from the cockpit before this widget forwarded them.
        const filter: MemoryListFilter = {
          type,
          scope,
          excludeSuperseded,
          projectScope,
          sort: parseSort(query?.sort),
          dir: parseDir(query?.dir),
          limit,
          offset,
          tags: parseTags(query?.tags),
          nameContains: query?.nameContains,
          since: query?.since,
          until: query?.until,
          stale,
          stalenessDays,
          untagged,
          neverAccessed,
          cold,
          coldDays,
          onlySuperseded,
          association,
        };

        // mt#4761 (PR #3488 R1 BLOCKING): one call, not `list()` + a separate
        // `count()` — `listWithMeta()` is `list()` and `count()` paired
        // server-side so this widget makes exactly one call to the service
        // for both the page and the total. `records.length` (the SQL-limited
        // page) would silently report `truncated: false` once a real cap
        // applies, which is exactly what a bare `list()` result cannot
        // distinguish. A MemoryServiceSurface fake that doesn't implement
        // `listWithMeta` (e.g. the mt#4727 two-project-fixture test) falls
        // back to the pre-mt#4761 behavior of treating `list()`'s own result
        // as the full matching set.
        let records: MemoryRecord[];
        let total: number;
        if (memSvc.listWithMeta) {
          const result = await memSvc.listWithMeta(filter);
          records = result.records;
          total = result.meta.total;
        } else {
          records = await memSvc.list(filter);
          total = records.length;
        }

        const payload: MemoriesListPayload = {
          records: records.map((r) => ({ ...toMemorySummary(r), shortId: r.shortId })),
          total,
        };

        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("memories list", err) };
      }
    },
  };
}

/** Default production widget — the real shared MemoryService singleton. */
export const memoriesListWidget: WidgetModule = createMemoriesListWidget(getSharedMemoryService);
