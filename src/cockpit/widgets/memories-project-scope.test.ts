/**
 * Two-project-fixture tests for the memories-list, memories-search, and
 * memories-stats widgets' project-scope wiring (mt#4727).
 *
 * `MemoryService.list({ projectScope })`'s actual DB-level filtering is
 * already comprehensively two-project tested at the domain layer
 * (`tests/domain/project-scope-acceptance.test.ts` — "Memory —
 * MemoryService.list projectScope filtering"). These tests cover what that
 * suite cannot: that each WIDGET actually reads `ctx.query.project`, resolves
 * it via `resolveCockpitProjectScope`, and passes the resulting scope through
 * to the memory service — using a fake `MemoryServiceSurface` partitioned by
 * project, mirroring `task-list.test.ts`'s wiring-test pattern.
 *
 * All three widgets were converted from a bare `WidgetModule` object literal
 * to a `createXWidget(getMemService, getProjectScopeDb?)` factory (this task)
 * specifically to enable this DI seam — production behavior is unchanged
 * (the default exports still point at the real `getSharedMemoryService()`
 * singleton, with `getProjectScopeDb` omitted so `resolveCockpitProjectScope`
 * falls back to its own real `defaultGetDb`).
 */
import { describe, test, expect } from "bun:test";
import { createMemoriesListWidget, type MemoriesListPayload } from "./memories-list";
import { createMemoriesSearchWidget, type MemoriesSearchPayload } from "./memories-search";
import { createMemoriesStatsWidget, type MemoriesStatsPayload } from "./memories-stats";
import type {
  MemoryListFilter,
  MemoryRecord,
  MemorySearchOptions,
} from "@minsky/domain/memory/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { isAllProjects } from "@minsky/domain/project/scope";

const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A_SLUG = "edobry/minsky";

function makeRecord(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    type: "project",
    name: `memory ${overrides.id}`,
    description: "",
    content: "",
    scope: "project",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

// Two-project fixture: mem-a belongs to project A, mem-b to project B.
const MEM_A = makeRecord({ id: "mem-a", projectId: PROJECT_A_ID });
const MEM_B = makeRecord({ id: "mem-b", projectId: PROJECT_B_ID });

/** Fake MemoryServiceSurface partitioned by project — the two-project fixture. */
function makeTwoProjectMemService(
  onList: (filter?: MemoryListFilter) => void,
  onSearch: (query: string, opts?: MemorySearchOptions) => void
): MemoryServiceSurface {
  function byScope(scope: MemoryListFilter["projectScope"]): MemoryRecord[] {
    if (scope === PROJECT_A_ID) return [MEM_A];
    if (scope === PROJECT_B_ID) return [MEM_B];
    return [MEM_A, MEM_B];
  }
  return {
    list: async (filter?: MemoryListFilter) => {
      onList(filter);
      return byScope(filter?.projectScope);
    },
    search: async (query: string, opts?: MemorySearchOptions) => {
      onSearch(query, opts);
      const records = byScope(opts?.filter?.projectScope);
      return {
        results: records.map((record) => ({ record, score: 1 })),
        backend: "lexical" as const,
        degraded: false,
      };
    },
    get: async () => null,
    getWithoutAccessTracking: async () => null,
    create: async () => {
      throw new Error("not implemented in fake");
    },
    update: async () => null,
    delete: async () => {},
    similar: async () => [],
    supersede: async () => {
      throw new Error("not implemented in fake");
    },
    lineage: async () => ({ chain: [], truncated: false }),
  };
}

/** Fake scope-resolver db resolving exactly the given slug->uuid rows. */
function makeScopeResolverDb(rows: Array<{ id: string; slug: string }>): ScopeResolverDb {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("memories-list — project-scope wiring (mt#4727)", () => {
  test("no ?project=: ALL_PROJECTS reaches memSvc.list and both projects' records return", async () => {
    let captured: MemoryListFilter | undefined;
    const widget = createMemoriesListWidget(async () =>
      makeTwoProjectMemService(
        (f) => {
          captured = f;
        },
        () => {}
      )
    );

    const data = await widget.fetch({ id: "memories-list" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesListPayload;
    expect(payload.records.map((r) => r.id).sort()).toEqual(["mem-a", "mem-b"]);

    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("?project=<project A slug> resolves to project A's uuid and returns only its records", async () => {
    let captured: MemoryListFilter | undefined;
    const widget = createMemoriesListWidget(
      async () =>
        makeTwoProjectMemService(
          (f) => {
            captured = f;
          },
          () => {}
        ),
      async () => makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }])
    );

    const data = await widget.fetch({
      id: "memories-list",
      query: { project: PROJECT_A_SLUG },
    });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesListPayload;
    expect(payload.records.map((r) => r.id)).toEqual(["mem-a"]);
    expect(captured?.projectScope).toBe(PROJECT_A_ID);
  });
});

describe("memories-search — project-scope wiring (mt#4727)", () => {
  test("no ?project=: ALL_PROJECTS reaches memSvc.search's filter and both projects' results return", async () => {
    let capturedOpts: MemorySearchOptions | undefined;
    const widget = createMemoriesSearchWidget(async () =>
      makeTwoProjectMemService(
        () => {},
        (_q, opts) => {
          capturedOpts = opts;
        }
      )
    );

    const data = await widget.fetch({ id: "memories-search", query: { q: "test" } });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesSearchPayload;
    expect(payload.results.map((r) => r.record.id).sort()).toEqual(["mem-a", "mem-b"]);

    const projectScope = capturedOpts?.filter?.projectScope;
    if (!projectScope) throw new Error("expected filter.projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("?project=<project A slug> resolves to project A's uuid and returns only its results", async () => {
    let capturedOpts: MemorySearchOptions | undefined;
    const widget = createMemoriesSearchWidget(
      async () =>
        makeTwoProjectMemService(
          () => {},
          (_q, opts) => {
            capturedOpts = opts;
          }
        ),
      async () => makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }])
    );

    const data = await widget.fetch({
      id: "memories-search",
      query: { q: "test", project: PROJECT_A_SLUG },
    });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesSearchPayload;
    expect(payload.results.map((r) => r.record.id)).toEqual(["mem-a"]);
    expect(capturedOpts?.filter?.projectScope).toBe(PROJECT_A_ID);
  });

  test("an empty query short-circuits before the memory service is ever called", async () => {
    let called = false;
    const widget = createMemoriesSearchWidget(async () => {
      called = true;
      return makeTwoProjectMemService(
        () => {},
        () => {}
      );
    });

    const data = await widget.fetch({ id: "memories-search", query: { q: "" } });
    expect(data.state).toBe("ok");
    expect(called).toBe(false);
  });
});

describe("memories-stats — project-scope wiring (mt#4727)", () => {
  test("no ?project=: ALL_PROJECTS reaches memSvc.list and totals cover both projects", async () => {
    let captured: MemoryListFilter | undefined;
    const widget = createMemoriesStatsWidget(async () =>
      makeTwoProjectMemService(
        (f) => {
          captured = f;
        },
        () => {}
      )
    );

    const data = await widget.fetch({ id: "memories-stats" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesStatsPayload;
    expect(payload.total).toBe(2);

    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("?project=<project A slug> resolves to project A's uuid and totals cover only its records", async () => {
    let captured: MemoryListFilter | undefined;
    const widget = createMemoriesStatsWidget(
      async () =>
        makeTwoProjectMemService(
          (f) => {
            captured = f;
          },
          () => {}
        ),
      async () => makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }])
    );

    const data = await widget.fetch({
      id: "memories-stats",
      query: { project: PROJECT_A_SLUG },
    });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as MemoriesStatsPayload;
    expect(payload.total).toBe(1);
    expect(captured?.projectScope).toBe(PROJECT_A_ID);
  });
});
