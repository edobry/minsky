/**
 * Embedding-backed similarity project-scope acceptance tests (mt#2939)
 *
 * mt#2416 (ADR-021, DONE) scoped the direct list/search paths (tasks_list,
 * memory.search/list) to a resolved project. It did NOT cover the
 * embedding-backed *similarity* endpoints:
 *
 *   - TaskSimilarityService.similarToTask() / searchByText() / searchSimilarTasks()
 *     — the "fast path" (no domain filter, used by similarToTask/searchSimilarTasks
 *     and by searchByText when no status/backend/kind filter is supplied) returned
 *     raw, unscoped vector-search results with no live-tasks-table cross-check.
 *   - MemoryService.similar() — no projectScope parameter at all.
 *
 * This suite follows the tests/domain/project-scope-acceptance.test.ts pattern:
 * a fake DB that renders real Drizzle WHERE conditions via PgDialect.sqlToQuery
 * and evaluates them against in-memory rows (NOT a fully-mocked no-op fake), so
 * a regressed filter — e.g. `searchTasks({})` losing its `projectScope` forward,
 * or the fast-path routing skipping the live cross-check again — actually fails
 * these tests instead of passing vacuously.
 */

import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ALL_PROJECTS } from "@minsky/domain/project/scope";
import { TaskSimilarityService } from "@minsky/domain/tasks/task-similarity-service";
import { MinskyTaskBackend } from "@minsky/domain/tasks/minskyTaskBackend";
import { MemoryService, type MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import { MemoryVectorStorage } from "@minsky/domain/storage/vector/memory-vector-storage";
import type { EmbeddingService } from "@minsky/domain/ai/embeddings/types";
import type { VectorStorage } from "@minsky/domain/storage/vector/types";

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Shared: fake MinskyBackendDb — renders real WHERE SQL via PgDialect and
// evaluates it against in-memory rows (adapted from project-scope-acceptance.test.ts).
// ---------------------------------------------------------------------------

interface FakeTaskRow {
  id: string;
  title: string;
  status: string;
  backend: string;
  tags: string;
  kind: string;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeTaskDb(rows: FakeTaskRow[]) {
  const pgDialect = new PgDialect();

  function evalWhere(sql: string, params: unknown[], row: Record<string, unknown>): boolean {
    let s = sql.trim();
    while (s.startsWith("(") && s.endsWith(")")) {
      s = s.slice(1, -1).trim();
    }

    const andParts = splitTopLevel(s, " and ");
    if (andParts.length > 1) return andParts.every((p) => evalWhere(p, params, row));

    const orParts = splitTopLevel(s, " or ");
    if (orParts.length > 1) return orParts.some((p) => evalWhere(p, params, row));

    const eqMatch = /^"(\w+)"\."(\w+)" = \$(\d+)$/.exec(s.trim());
    if (eqMatch) {
      const colName = eqMatch[2] as string;
      const paramIdx = Number(eqMatch[3]) - 1;
      const key = colName === "project_id" ? "projectId" : colName;
      return row[key] === params[paramIdx];
    }

    const notMatch = /^not \("(\w+)"\."(\w+)" = \$(\d+)\)$/.exec(s.trim());
    if (notMatch) {
      const colName = notMatch[2] as string;
      const paramIdx = Number(notMatch[3]) - 1;
      const key = colName === "project_id" ? "projectId" : colName;
      return row[key] !== params[paramIdx];
    }

    const likeMatch = /^"(\w+)"\."(\w+)" like \$(\d+)$/.exec(s.trim());
    if (likeMatch) {
      const colName = likeMatch[2] as string;
      const paramIdx = Number(likeMatch[3]) - 1;
      const key = colName === "project_id" ? "projectId" : colName;
      const pattern = String(params[paramIdx]).replace(/%/g, ".*");
      return new RegExp(`^${pattern}$`).test(String(row[key] ?? ""));
    }

    // Fail-closed: an unrecognized WHERE shape must throw, not silently match all rows.
    throw new Error(`evalWhere: unrecognized WHERE pattern: ${s}`);
  }

  function splitTopLevel(sql: string, keyword: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      else if (depth === 0 && sql.slice(i, i + keyword.length) === keyword) {
        parts.push(sql.slice(start, i).trim());
        start = i + keyword.length;
      }
    }
    parts.push(sql.slice(start).trim());
    return parts;
  }

  const db = {
    select() {
      let _whereCond: unknown = null;
      const chain = {
        from(_table: unknown) {
          void _table;
          return chain;
        },
        where(cond: unknown) {
          _whereCond = cond;
          return chain;
        },
        limit(_n: number) {
          return chain;
        },
        then(resolve: (v: FakeTaskRow[]) => void, reject?: (err: unknown) => void) {
          try {
            if (_whereCond) {
              const { sql: rendered, params } = pgDialect.sqlToQuery(_whereCond as any);
              resolve(
                rows.filter((r) =>
                  evalWhere(rendered, params, r as unknown as Record<string, unknown>)
                )
              );
            } else {
              resolve(rows);
            }
          } catch (err) {
            if (reject) reject(err);
          }
        },
      };
      return chain;
    },
    insert() {
      return {
        values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) }),
      };
    },
    update() {
      return { set: () => ({ where: () => Promise.resolve([]) }) };
    },
    delete() {
      return { where: () => ({ returning: () => Promise.resolve([]) }) };
    },
    transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };

  return db;
}

function taskRow(
  id: string,
  projectId: string | null,
  opts: Partial<FakeTaskRow> = {}
): FakeTaskRow {
  return {
    id,
    title: `Task ${id}`,
    status: "TODO",
    backend: "minsky",
    tags: "[]",
    kind: "implementation",
    projectId,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Deterministic embedding service — maps known content markers to fixed
// vectors so vector-search neighbor ordering is fully predictable.
// ---------------------------------------------------------------------------

function embedDeterministic(text: string): number[] {
  if (text.includes("FAR")) return [100, 100, 100, 100];
  if (text.includes("NEARDUPE")) return [0, 0, 0, 1];
  return [0, 0, 0, 0];
}

function makeDeterministicEmbeddingService(): EmbeddingService {
  return {
    async generateEmbedding(text: string): Promise<number[]> {
      return embedDeterministic(text);
    },
    async generateEmbeddings(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => embedDeterministic(t)));
    },
  } as unknown as EmbeddingService;
}

// ---------------------------------------------------------------------------
// 1. TaskSimilarityService — fast-path + filtered-path project scoping
// ---------------------------------------------------------------------------

describe("TaskSimilarityService project scoping (ADR-021, mt#2939)", () => {
  // A1 (project A) and B1 (project B) embed to near-duplicate vectors (a
  // cross-project "leak" candidate); A2 (project A) embeds far away so it's
  // only surfaced when the candidate window widens past the top match.
  const specs: Record<string, string> = {
    "mt#a1": "ALPHA content — the source task",
    "mt#b1": "ALPHA content NEARDUPE — cross-project near duplicate",
    "mt#a2": "FAR content — unrelated task in the same project as A1",
  };

  let db: ReturnType<typeof makeTaskDb>;
  let backend: MinskyTaskBackend;
  let service: TaskSimilarityService;

  beforeEach(() => {
    db = makeTaskDb([
      taskRow("mt#a1", PROJECT_A),
      taskRow("mt#b1", PROJECT_B),
      taskRow("mt#a2", PROJECT_A),
    ]);
    backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    const embedding = makeDeterministicEmbeddingService();
    const vectorStorage = new MemoryVectorStorage(4);

    const findTaskById = async (id: string) => backend.getTask(id);
    // Real listTasks() call — a regression that stops forwarding projectScope
    // here (or that TaskSimilarityService stops passing it in) surfaces as a
    // WHERE clause with no project_id predicate, so the fake DB returns both
    // projects' rows and the assertions below fail.
    const searchTasks = async (opts: { text?: string; projectScope?: any }) =>
      backend.listTasks({ all: true, projectScope: opts?.projectScope });
    const getTaskSpecContent = async (id: string) => ({
      content: specs[id] ?? "",
      specPath: "",
      task: { id } as any,
    });

    service = new TaskSimilarityService(
      embedding,
      vectorStorage,
      findTaskById,
      searchTasks,
      getTaskSpecContent,
      {}
    );

    // Seed embeddings for all three tasks directly (bypassing indexTask's
    // content-hash bookkeeping — not under test here).
    const seed = async () => {
      for (const [id, content] of Object.entries(specs)) {
        const vector = await embedding.generateEmbedding(content);
        await vectorStorage.store(id, vector, { taskId: id });
      }
    };
    return seed();
  });

  describe("similarToTask (fast-path caller)", () => {
    it("ALL_PROJECTS (default) includes the cross-project near-duplicate", async () => {
      const response = await service.similarToTask("mt#a1", 2);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#b1");
    });

    it("projectScope = PROJECT_A excludes project B's near-duplicate task", async () => {
      const response = await service.similarToTask("mt#a1", 2, undefined, PROJECT_A);
      const ids = response.results.map((r) => r.id);
      expect(ids).not.toContain("mt#b1");
      // The source task and/or its in-project sibling take B1's place.
      expect(ids.every((id) => id === "mt#a1" || id === "mt#a2")).toBe(true);
    });

    it("explicit ALL_PROJECTS opt-out returns both projects' tasks", async () => {
      const response = await service.similarToTask("mt#a1", 3, undefined, ALL_PROJECTS);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#a1");
      expect(ids).toContain("mt#b1");
    });
  });

  describe("searchByText (fast-path AND filtered-path caller)", () => {
    it("fast path (no domain filter, ALL_PROJECTS): includes cross-project match", async () => {
      const response = await service.searchByText("ALPHA", 2, undefined, undefined, ALL_PROJECTS);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#b1");
    });

    it("no domain filter but projectScope=PROJECT_A: excludes project B's task", async () => {
      const response = await service.searchByText("ALPHA", 2, undefined, undefined, PROJECT_A);
      const ids = response.results.map((r) => r.id);
      expect(ids).not.toContain("mt#b1");
      expect(ids).toContain("mt#a1");
    });

    it("projectScope=PROJECT_B: returns only project B's task", async () => {
      const response = await service.searchByText("ALPHA", 5, undefined, undefined, PROJECT_B);
      const ids = response.results.map((r) => r.id);
      expect(ids).toEqual(["mt#b1"]);
    });

    it("ALL_PROJECTS explicit opt-out returns tasks from both projects", async () => {
      const response = await service.searchByText("ALPHA", 5, undefined, undefined, ALL_PROJECTS);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#a1");
      expect(ids).toContain("mt#b1");
    });

    it("omitting projectScope defaults to ALL_PROJECTS (back-compat)", async () => {
      const response = await service.searchByText("ALPHA", 5);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#a1");
      expect(ids).toContain("mt#b1");
    });
  });

  describe("searchSimilarTasks (fast-path caller)", () => {
    it("projectScope=PROJECT_A excludes project B's task", async () => {
      const response = await service.searchSimilarTasks(["ALPHA"], [], 5, undefined, PROJECT_A);
      const ids = response.results.map((r) => r.id);
      expect(ids).not.toContain("mt#b1");
      expect(ids).toContain("mt#a1");
    });

    it("ALL_PROJECTS (default) includes both projects' tasks", async () => {
      const response = await service.searchSimilarTasks(["ALPHA"], [], 5);
      const ids = response.results.map((r) => r.id);
      expect(ids).toContain("mt#a1");
      expect(ids).toContain("mt#b1");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. createTaskSimilarityService's searchTasks closure — the exact gap named
//    in mt#2939's spec ("its searchTasks({}) closure ... calls
//    taskService.listTasks({}) with no projectScope").
// ---------------------------------------------------------------------------

describe("createTaskSimilarityService searchTasks closure forwards projectScope (mt#2939)", () => {
  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration/index"
    );
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  it("forwards the resolved projectScope into taskService.listTasks", async () => {
    const { createTaskSimilarityService } = await import(
      "../../src/adapters/shared/commands/tasks/similarity-commands"
    );

    const capturedOptions: unknown[] = [];
    const fakeTaskService = {
      listTasks: async (options?: unknown) => {
        capturedOptions.push(options);
        return [];
      },
      getTask: async () => null,
      getTaskStatus: async () => undefined,
      setTaskStatus: async () => void 0,
      createTaskFromTitleAndSpec: async () => {
        throw new Error("not implemented");
      },
      deleteTask: async () => false,
      getTasks: async () => [],
      getTaskSpecContent: async () => ({ task: {} as any, specPath: "", content: "" }),
      getWorkspacePath: () => "/tmp/ws",
    };

    const fakeVectorStorage: VectorStorage = {
      store: async () => void 0,
      delete: async () => void 0,
      search: async () => [],
    } as unknown as VectorStorage;

    const fakePersistenceProvider = {
      capabilities: {
        sql: true,
        vectorStorage: true,
        transactions: true,
        jsonb: true,
        migrations: true,
      },
      getCapabilities() {
        return this.capabilities;
      },
      initialize: async () => void 0,
      close: async () => void 0,
      getConnectionInfo: () => "fake",
      getVectorStorageForDomain: () => fakeVectorStorage,
    };

    const service = await createTaskSimilarityService(
      fakePersistenceProvider as any,
      fakeTaskService as any
    );

    // Trigger a filtered-path search (projectScope active), which calls
    // searchTasks({ projectScope }) internally.
    await service.searchByText("query", 5, undefined, undefined, PROJECT_A);

    const sawScopedCall = capturedOptions.some(
      (opts) => (opts as { projectScope?: string } | undefined)?.projectScope === PROJECT_A
    );
    expect(sawScopedCall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. MemoryService.similar() — project scoping (mt#2939)
// ---------------------------------------------------------------------------

type MemoryRow = {
  id: string;
  type: string;
  name: string;
  description: string;
  content: string;
  scope: string;
  project_id: string | null;
  tags: string[];
  source_agent_id: string | null;
  source_session_id: string | null;
  confidence: number | null;
  superseded_by: string | null;
  metadata: Record<string, unknown> | null;
  associations: Record<string, string[]>;
  created_at: Date;
  updated_at: Date;
  last_accessed_at: Date | null;
  access_count: number;
};

const pgDialectMem = new PgDialect();

function evalMemWhere(sql: string, params: unknown[], row: MemoryRow): boolean {
  let s = sql.trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();

  const andParts = splitMemTopLevel(s, " and ");
  if (andParts.length > 1) return andParts.every((p) => evalMemWhere(p, params, row));

  const orParts = splitMemTopLevel(s, " or ");
  if (orParts.length > 1) return orParts.some((p) => evalMemWhere(p, params, row));

  const eqMatch = /^"memories"\."(\w+)" = \$(\d+)$/.exec(s.trim());
  if (eqMatch) {
    const colName = eqMatch[1] as keyof MemoryRow;
    const paramIdx = Number(eqMatch[2]) - 1;
    return row[colName] === params[paramIdx];
  }

  const inMatch = /^"memories"\."(\w+)" in \(([^)]*)\)$/.exec(s.trim());
  if (inMatch) {
    const colName = inMatch[1] as keyof MemoryRow;
    const placeholdersRaw = inMatch[2] ?? "";
    const placeholderIdx = placeholdersRaw
      .split(",")
      .map((p) => Number(p.trim().replace("$", "")) - 1);
    const values = placeholderIdx.map((i) => params[i]);
    return values.includes(row[colName]);
  }

  throw new Error(`evalMemWhere: unrecognized WHERE pattern: ${s}`);
}

function splitMemTopLevel(sql: string, keyword: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && sql.slice(i, i + keyword.length) === keyword) {
      parts.push(sql.slice(start, i).trim());
      start = i + keyword.length;
    }
  }
  parts.push(sql.slice(start).trim());
  return parts;
}

let memIdCounter = 1;
function genMemId(): string {
  return `mem-${String(memIdCounter++).padStart(4, "0")}`;
}

function createMemoryFakeDb(
  initialRows: MemoryRow[] = []
): MemoryServiceDb & { _rows: Map<string, MemoryRow> } {
  const rows = new Map<string, MemoryRow>(initialRows.map((r) => [r.id, r]));

  function queryRows(cond?: any): MemoryRow[] {
    const all = Array.from(rows.values());
    if (!cond) return all;
    const { sql, params } = pgDialectMem.sqlToQuery(cond);
    return all.filter((r) => evalMemWhere(sql, params, r));
  }

  const fakeDb: MemoryServiceDb & { _rows: Map<string, MemoryRow> } = {
    _rows: rows,
    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(cond: any) {
              return {
                then(resolve: (v: MemoryRow[]) => void, reject?: (err: unknown) => void) {
                  Promise.resolve(queryRows(cond)).then(resolve, reject);
                },
              };
            },
            then(resolve: (v: MemoryRow[]) => void) {
              resolve(queryRows());
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(data: Record<string, any>) {
          const id = (data["id"] as string | undefined) ?? genMemId();
          const row: MemoryRow = {
            id,
            type: data["type"] ?? "user",
            name: data["name"] ?? "",
            description: data["description"] ?? "",
            content: data["content"] ?? "",
            scope: data["scope"] ?? "user",
            project_id: data["projectId"] ?? data["project_id"] ?? null,
            tags: data["tags"] ?? [],
            source_agent_id: null,
            source_session_id: null,
            confidence: null,
            superseded_by: null,
            metadata: null,
            associations: {},
            created_at: new Date(),
            updated_at: new Date(),
            last_accessed_at: null,
            access_count: 0,
          };
          rows.set(id, row);
          return { returning: () => Promise.resolve([row]) };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(data: Record<string, any>) {
          return {
            where(cond: any) {
              const matched = queryRows(cond);
              for (const row of matched) {
                rows.set(row.id, {
                  ...row,
                  ...(data as Partial<MemoryRow>),
                  updated_at: new Date(),
                });
              }
              return { returning: () => Promise.resolve(matched.map((r) => rows.get(r.id) ?? r)) };
            },
          };
        },
      };
    },
    delete(_table: unknown) {
      return {
        where(cond: any) {
          const matched = queryRows(cond);
          for (const r of matched) rows.delete(r.id);
          return Promise.resolve();
        },
      };
    },
    transaction<T>(fn: (tx: MemoryServiceDb) => Promise<T>): Promise<T> {
      return fn(fakeDb);
    },
  };

  return fakeDb;
}

// MemoryService.similar() requires vectorStorage.getMetadata() as its
// "does this record even have an embedding" precondition check.
// MemoryVectorStorage (the in-memory VectorStorage impl reused above for the
// task-similarity suites) does not implement the optional getMetadata()
// method, so a dedicated minimal fake is used here instead.
function makeVectorStorageWithMetadata(dimension: number): VectorStorage {
  const storeMap = new Map<string, { vector: number[]; metadata?: Record<string, unknown> }>();

  function l2(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      s += d * d;
    }
    return Math.sqrt(s);
  }

  return {
    async store(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
      if (vector.length !== dimension) {
        throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${vector.length}`);
      }
      storeMap.set(id, { vector, metadata });
    },
    async search(queryVector, options = {}) {
      const { limit = 10, threshold = Number.POSITIVE_INFINITY } = options;
      const results = Array.from(storeMap.entries()).map(([id, { vector, metadata }]) => ({
        id,
        score: l2(queryVector, vector),
        metadata,
      }));
      results.sort((a, b) => a.score - b.score);
      return results.filter((r) => r.score <= threshold).slice(0, limit);
    },
    async delete(id: string): Promise<void> {
      storeMap.delete(id);
    },
    async getMetadata(id: string): Promise<Record<string, unknown> | null> {
      const entry = storeMap.get(id);
      return entry ? (entry.metadata ?? {}) : null;
    },
  };
}

describe("MemoryService.similar() project scoping (ADR-021, mt#2939)", () => {
  let db: ReturnType<typeof createMemoryFakeDb>;
  let vectorStorage: VectorStorage;
  let service: MemoryService;

  const embeddingService = {
    generateEmbedding: async (text: string): Promise<number[]> => embedDeterministic(text),
    generateEmbeddings: async (texts: string[]): Promise<number[][]> =>
      Promise.all(texts.map((t) => embedDeterministic(t))),
  };

  beforeEach(async () => {
    memIdCounter = 1;
    db = createMemoryFakeDb();
    vectorStorage = makeVectorStorageWithMetadata(4);
    service = new MemoryService({ db, vectorStorage, embeddingService: embeddingService as any });

    // Seed: source memory (project A), a near-duplicate in project B (the
    // cross-project leak candidate), and an unrelated far memory (project A).
    await service.create({
      type: "user",
      name: "source-a",
      description: "d",
      content: "ALPHA content — the source memory",
      scope: "project",
      projectId: PROJECT_A,
    });
    await service.create({
      type: "user",
      name: "near-dupe-b",
      description: "d",
      content: "ALPHA content NEARDUPE — cross-project near duplicate",
      scope: "project",
      projectId: PROJECT_B,
    });
    await service.create({
      type: "user",
      name: "far-a",
      description: "d",
      content: "FAR content — unrelated memory in project A",
      scope: "project",
      projectId: PROJECT_A,
    });
  });

  function sourceId(): string {
    const row = Array.from(db._rows.values()).find((r) => r.name === "source-a");
    if (!row) throw new Error("source-a not seeded");
    return row.id;
  }

  it("ALL_PROJECTS / omitted projectScope includes the cross-project near-duplicate", async () => {
    const results = await service.similar(sourceId(), { limit: 2 });
    const names = results.map((r) => r.record.name);
    expect(names).toContain("near-dupe-b");
  });

  it("projectScope = PROJECT_A excludes project B's near-duplicate memory", async () => {
    const results = await service.similar(sourceId(), { limit: 2, projectScope: PROJECT_A });
    const names = results.map((r) => r.record.name);
    expect(names).not.toContain("near-dupe-b");
  });

  it("projectScope = ALL_PROJECTS (explicit sentinel) includes both projects", async () => {
    const results = await service.similar(sourceId(), { limit: 5, projectScope: ALL_PROJECTS });
    const names = results.map((r) => r.record.name);
    expect(names).toContain("near-dupe-b");
    expect(names).toContain("far-a");
  });

  it("projectScope = PROJECT_B returns only project B's memories", async () => {
    const results = await service.similar(sourceId(), { limit: 5, projectScope: PROJECT_B });
    const names = results.map((r) => r.record.name);
    expect(names).toEqual(["near-dupe-b"]);
  });
});
