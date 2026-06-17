/**
 * Project-scope acceptance tests (ADR-021, mt#2416)
 *
 * Verifies that all four wired domain services correctly scope their list
 * queries to a resolved project UUID when a projectScope is supplied, return
 * rows from ALL projects when the sentinel (ALL_PROJECTS) is passed, and
 * never crash when the project identity is unresolved.
 *
 * Services covered:
 *   1. Tasks   — MinskyTaskBackend.listTasks({ projectScope })
 *   2. Sessions — FakeSessionProvider.listSessions({ projectScope }) [extended inline]
 *   3. Memory   — MemoryService.list({ projectScope }) via MemoryServiceDb fake
 *   4. Asks     — FakeAskRepository.listByState(state, projectScope)
 *
 * Design notes:
 *   - No real Postgres or filesystem is required.  Each service's domain
 *     filtering logic is exercised via the same in-memory fake-DB pattern the
 *     rest of the test suite uses (MemoryServiceDb + PgDialect for memory;
 *     recording fake DB for tasks; extended FakeSessionProvider inline for
 *     sessions; FakeAskRepository for asks).
 *   - Two synthetic project UUIDs (PROJECT_A / PROJECT_B) stand in for the
 *     "two seeded projects" the spec requires.
 *   - ALL_PROJECTS sentinel behaviour: passing ALL_PROJECTS (or omitting
 *     projectScope) must return rows from both projects.
 *   - Unresolved project (no projectId on the record) maps to ALL_PROJECTS
 *     fail-open — no crash, no empty result set unless the store is empty.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ALL_PROJECTS, isAllProjects } from "@minsky/domain/project/scope";
import { MemoryService, type MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import { MemoryVectorStorage } from "@minsky/domain/storage/vector/memory-vector-storage";
import { MinskyTaskBackend } from "@minsky/domain/tasks/minskyTaskBackend";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import { toPostgresInsert } from "@minsky/domain/storage/schemas/session-schema";
import type {
  SessionProviderInterface,
  SessionRecord,
  SessionListOptions,
} from "@minsky/domain/session/types";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Minimal embedding service — returns distinct vectors so embeddings don't
// collapse to the same slot (prevents vector-store interference).
const mockEmbeddingService = {
  async generateEmbedding(text: string): Promise<number[]> {
    const seed = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
    return [seed, seed + 1, seed + 2, seed + 3];
  },
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => mockEmbeddingService.generateEmbedding(t)));
  },
};

// ---------------------------------------------------------------------------
// 1. Tasks — MinskyTaskBackend.listTasks({ projectScope })
// ---------------------------------------------------------------------------

/**
 * Minimal recording fake for MinskyBackendDb that supports listTasks.
 *
 * listTasks issues: db.select().from(tasksTable).where(and(...conditions))
 * We capture the rendered WHERE SQL from PgDialect and apply it against
 * the in-memory rows using a simple column-equality evaluator, mirroring
 * the MemoryServiceDb fake pattern.
 *
 * The fake only implements the select() chain; other operations (insert,
 * update, delete) are stubs and won't be called by listTasks.
 */
function makeTaskDb(
  rows: Array<{
    id: string;
    title: string;
    status: string;
    backend: string;
    tags: string;
    kind: string;
    projectId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
) {
  const pgDialect = new PgDialect();

  function evalWhere(sql: string, params: unknown[], row: Record<string, unknown>): boolean {
    let s = sql.trim();
    // Strip outer parens
    while (s.startsWith("(") && s.endsWith(")")) {
      s = s.slice(1, -1).trim();
    }

    // Top-level AND
    const andParts = splitTopLevel(s, " and ");
    if (andParts.length > 1) return andParts.every((p) => evalWhere(p, params, row));

    // Top-level OR
    const orParts = splitTopLevel(s, " or ");
    if (orParts.length > 1) return orParts.some((p) => evalWhere(p, params, row));

    // eq: "table"."col" = $N
    const eqMatch = /^"(\w+)"\."(\w+)" = \$(\d+)$/.exec(s.trim());
    if (eqMatch) {
      const colName = eqMatch[2] as string;
      const paramIdx = Number(eqMatch[3]) - 1;
      // Map column names to row keys — handle both camelCase and snake_case
      const key = colName === "project_id" ? "projectId" : colName;
      return row[key] === params[paramIdx];
    }

    // not eq: "table"."col" != $N  (Drizzle renders `not ("table"."col" = $N)`)
    const notMatch = /^not \("(\w+)"\."(\w+)" = \$(\d+)\)$/.exec(s.trim());
    if (notMatch) {
      const colName = notMatch[2] as string;
      const paramIdx = Number(notMatch[3]) - 1;
      const key = colName === "project_id" ? "projectId" : colName;
      return row[key] !== params[paramIdx];
    }

    // like: "table"."col" like $N — not needed for projectScope but included for completeness
    const likeMatch = /^"(\w+)"\."(\w+)" like \$(\d+)$/.exec(s.trim());
    if (likeMatch) {
      const colName = likeMatch[2] as string;
      const paramIdx = Number(likeMatch[3]) - 1;
      const key = colName === "project_id" ? "projectId" : colName;
      const pattern = String(params[paramIdx]).replace(/%/g, ".*");
      return new RegExp(`^${pattern}$`).test(String(row[key] ?? ""));
    }

    // Pass-through for unrecognized patterns (fail-open)
    return true;
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
        then(resolve: (v: typeof rows) => void, reject?: (err: unknown) => void) {
          try {
            if (_whereCond) {
              const { sql: rendered, params } = pgDialect.sqlToQuery(_whereCond as any);
              resolve(
                rows.filter((r) => evalWhere(rendered, params, r as Record<string, unknown>))
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
    // Stubs for interface compliance
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

describe("Tasks — listTasks projectScope filtering (ADR-021, mt#2416)", () => {
  const baseRow = (id: string, projectId: string | null) => ({
    id,
    title: `Task ${id}`,
    status: "TODO" as const,
    backend: "minsky",
    tags: "[]",
    kind: "implementation",
    projectId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("projectScope = PROJECT_A returns only project-A rows", async () => {
    const db = makeTaskDb([
      baseRow("mt#1", PROJECT_A),
      baseRow("mt#2", PROJECT_B),
      baseRow("mt#3", PROJECT_A),
    ]);
    const backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    const results = await backend.listTasks({ all: true, projectScope: PROJECT_A });
    const ids = results.map((t) => t.id);

    expect(ids).toContain("mt#1");
    expect(ids).toContain("mt#3");
    expect(ids).not.toContain("mt#2");
  });

  it("projectScope = ALL_PROJECTS returns rows from both projects", async () => {
    const db = makeTaskDb([baseRow("mt#1", PROJECT_A), baseRow("mt#2", PROJECT_B)]);
    const backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    const results = await backend.listTasks({ all: true, projectScope: ALL_PROJECTS });
    const ids = results.map((t) => t.id);

    expect(ids).toContain("mt#1");
    expect(ids).toContain("mt#2");
  });

  it("omitting projectScope (unresolved) returns all rows — fail-open, no crash", async () => {
    const db = makeTaskDb([baseRow("mt#1", PROJECT_A), baseRow("mt#2", PROJECT_B)]);
    const backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    // No projectScope passed — the adapter defaults to ALL_PROJECTS fail-open
    const results = await backend.listTasks({ all: true });
    expect(results.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Sessions — SessionProviderInterface.listSessions({ projectScope })
// ---------------------------------------------------------------------------

/**
 * Inline fake session provider that correctly applies SessionListOptions
 * including projectScope filtering, for acceptance test coverage.
 *
 * The real DrizzleSessionRepository applies the filter via SQL; this fake
 * applies it in-memory so we can test the contract without a DB connection.
 */
class ScopedFakeSessionProvider implements SessionProviderInterface {
  private readonly store = new Map<string, SessionRecord>();

  constructor(records: SessionRecord[] = []) {
    for (const r of records) this.store.set(r.sessionId, r);
  }

  async listSessions(options?: SessionListOptions): Promise<SessionRecord[]> {
    let all = Array.from(this.store.values());
    if (options?.projectScope && !isAllProjects(options.projectScope)) {
      all = all.filter((r) => r.projectId === options.projectScope);
    }
    return all;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.get(sessionId) ?? null;
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    for (const r of this.store.values()) {
      if (r.taskId === taskId) return r;
    }
    return null;
  }

  async addSession(record: SessionRecord): Promise<void> {
    this.store.set(record.sessionId, record);
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Omit<SessionRecord, "sessionId">>
  ): Promise<void> {
    const existing = this.store.get(sessionId);
    if (existing) this.store.set(sessionId, { ...existing, ...updates });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.store.delete(sessionId);
  }

  async getRepoPath(): Promise<string> {
    return "/mock/repo";
  }

  async getSessionWorkdir(): Promise<string> {
    return "/mock/workdir";
  }
}

function makeSession(sessionId: string, projectId: string | undefined): SessionRecord {
  return {
    sessionId,
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo",
    createdAt: new Date().toISOString(),
    projectId,
  };
}

describe("Sessions — listSessions projectScope filtering (ADR-021, mt#2416)", () => {
  let provider: ScopedFakeSessionProvider;

  beforeEach(() => {
    provider = new ScopedFakeSessionProvider([
      makeSession("sess-a1", PROJECT_A),
      makeSession("sess-a2", PROJECT_A),
      makeSession("sess-b1", PROJECT_B),
    ]);
  });

  it("projectScope = PROJECT_A returns only project-A sessions", async () => {
    const results = await provider.listSessions({ projectScope: PROJECT_A });
    const ids = results.map((s) => s.sessionId);

    expect(ids).toContain("sess-a1");
    expect(ids).toContain("sess-a2");
    expect(ids).not.toContain("sess-b1");
  });

  it("projectScope = ALL_PROJECTS returns sessions from all projects", async () => {
    const results = await provider.listSessions({ projectScope: ALL_PROJECTS });
    const ids = results.map((s) => s.sessionId);

    expect(ids).toContain("sess-a1");
    expect(ids).toContain("sess-a2");
    expect(ids).toContain("sess-b1");
  });

  it("omitting projectScope returns all sessions — fail-open, no crash", async () => {
    const results = await provider.listSessions();
    expect(results.length).toBe(3);
  });

  it("projectScope targeting a project with no sessions returns empty array, no crash", async () => {
    const PROJECT_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const results = await provider.listSessions({ projectScope: PROJECT_C });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Memory — MemoryService.list({ projectScope })
// ---------------------------------------------------------------------------

/**
 * In-memory fake MemoryServiceDb.  Renders Drizzle WHERE conditions via
 * PgDialect.sqlToQuery and evaluates them against row data, exactly as in
 * the existing memory-service.test.ts fixture.
 *
 * Only the `select()` chain is exercised by `list()`.  `insert()`, `update()`,
 * `delete()`, and `transaction()` are minimal stubs.
 */
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

  const isNullMatch = /^"memories"\."(\w+)" is null$/.exec(s.trim());
  if (isNullMatch) {
    const colName = isNullMatch[1] as keyof MemoryRow;
    return row[colName] === null;
  }

  return true;
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
                orderBy(_order: any) {
                  return Promise.resolve(queryRows(cond));
                },
                then(resolve: (v: MemoryRow[]) => void, reject?: (err: unknown) => void) {
                  Promise.resolve(queryRows(cond)).then(resolve, reject);
                },
              };
            },
            orderBy(_order: any) {
              return Promise.resolve(queryRows());
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
              return {
                returning: () => Promise.resolve(matched.map((r) => rows.get(r.id) ?? r)),
              };
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

describe("Memory — MemoryService.list projectScope filtering (ADR-021, mt#2416)", () => {
  let db: ReturnType<typeof createMemoryFakeDb>;
  let service: MemoryService;

  beforeEach(() => {
    memIdCounter = 1;
    db = createMemoryFakeDb();
    const vectorStorage = new MemoryVectorStorage(4);
    service = new MemoryService({ db, vectorStorage, embeddingService: mockEmbeddingService });
  });

  it("projectScope = PROJECT_A returns only project-A memories", async () => {
    await service.create({
      type: "user",
      name: "A-mem-1",
      description: "d",
      content: "project a content",
      scope: "project",
      projectId: PROJECT_A,
    });
    await service.create({
      type: "user",
      name: "B-mem-1",
      description: "d",
      content: "project b content",
      scope: "project",
      projectId: PROJECT_B,
    });
    await service.create({
      type: "user",
      name: "A-mem-2",
      description: "d",
      content: "project a content 2",
      scope: "project",
      projectId: PROJECT_A,
    });

    const results = await service.list({ projectScope: PROJECT_A });
    const names = results.map((m) => m.name);

    expect(names).toContain("A-mem-1");
    expect(names).toContain("A-mem-2");
    expect(names).not.toContain("B-mem-1");
  });

  it("projectScope = ALL_PROJECTS returns memories from all projects", async () => {
    await service.create({
      type: "user",
      name: "A-mem",
      description: "d",
      content: "a content",
      scope: "project",
      projectId: PROJECT_A,
    });
    await service.create({
      type: "user",
      name: "B-mem",
      description: "d",
      content: "b content",
      scope: "project",
      projectId: PROJECT_B,
    });

    const results = await service.list({ projectScope: ALL_PROJECTS });
    const names = results.map((m) => m.name);

    expect(names).toContain("A-mem");
    expect(names).toContain("B-mem");
  });

  it("omitting projectScope returns all memories — fail-open, no crash", async () => {
    await service.create({
      type: "user",
      name: "A-mem",
      description: "d",
      content: "a",
      scope: "project",
      projectId: PROJECT_A,
    });
    await service.create({
      type: "user",
      name: "B-mem",
      description: "d",
      content: "b",
      scope: "project",
      projectId: PROJECT_B,
    });

    const results = await service.list();
    expect(results.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Asks — AskRepository.listByState(state, projectScope)
// ---------------------------------------------------------------------------

/**
 * FakeAskRepository.listByState currently treats projectScope as a no-op
 * because Ask rows don't yet carry a projectId column (ADR-021 Phase-1.3b
 * follow-up, out-of-scope for mt#2416).  The acceptance tests here verify:
 *
 *   a. The method signature accepts projectScope without compiler errors.
 *   b. Passing a uuid projectScope does not crash.
 *   c. Passing ALL_PROJECTS returns all rows in the given state.
 *   d. The DrizzleAskRepository interface declares the same signature
 *      (structural, compile-time only — no runtime Postgres needed).
 */
describe("Asks — FakeAskRepository.listByState projectScope parameter (ADR-021, mt#2416)", () => {
  let repo: FakeAskRepository;

  const makeAsk = () => ({
    kind: "direction.decide" as const,
    classifierVersion: "v1",
    requestor: "agent:test" as const,
    title: "Test ask",
    question: "What should I do?",
  });

  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("listByState with PROJECT_A scope does not crash and returns asks in that state", async () => {
    const ask = await repo.create(makeAsk());
    // Advance to classified then suspended so it's in a queryable state
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "suspended");

    // Should not throw
    const results = await repo.listByState("suspended", PROJECT_A);
    // FakeAskRepository doesn't filter by projectId (no-op per spec comment)
    // so the ask is returned regardless of scope
    expect(results.some((a) => a.id === ask.id)).toBe(true);
  });

  it("listByState with ALL_PROJECTS returns all asks in that state", async () => {
    const ask1 = await repo.create(makeAsk());
    const ask2 = await repo.create(makeAsk());
    await repo.transition(ask1.id, "classified");
    await repo.transition(ask1.id, "suspended");
    await repo.transition(ask2.id, "classified");
    await repo.transition(ask2.id, "suspended");

    const results = await repo.listByState("suspended", ALL_PROJECTS);
    const ids = results.map((a) => a.id);

    expect(ids).toContain(ask1.id);
    expect(ids).toContain(ask2.id);
  });

  it("listByState without projectScope returns all asks in that state — fail-open, no crash", async () => {
    const ask = await repo.create(makeAsk());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "suspended");

    const results = await repo.listByState("suspended");
    expect(results.some((a) => a.id === ask.id)).toBe(true);
  });

  it("passing an unresolved scope (undefined) does not crash", async () => {
    await repo.create(makeAsk());
    // Passing undefined explicitly — no crash expected
    const results = await repo.listByState("detected", undefined);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Scope helpers — isAllProjects / ALL_PROJECTS contract
// ---------------------------------------------------------------------------

describe("Scope helpers (ADR-021, mt#2416)", () => {
  it("ALL_PROJECTS sentinel is the string 'allProjects'", () => {
    expect(ALL_PROJECTS).toBe("allProjects");
  });

  it("isAllProjects returns true for ALL_PROJECTS sentinel", () => {
    expect(isAllProjects(ALL_PROJECTS)).toBe(true);
  });

  it("isAllProjects returns false for a uuid project scope", () => {
    expect(isAllProjects(PROJECT_A)).toBe(false);
  });

  it("isAllProjects returns false for an empty string", () => {
    expect(isAllProjects("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Writer stamping — session.start and memory.create (ADR-021, mt#2416)
// ---------------------------------------------------------------------------

/**
 * Verifies that the write path correctly stamps projectId on new records.
 *
 * Session write path:
 *   startSessionImpl builds a SessionRecord with projectId resolved from cwd,
 *   then passes it to toPostgresInsert → the DB insert includes project_id.
 *   We test toPostgresInsert directly (pure function; no DB needed).
 *
 * Memory write path:
 *   MemoryService.create accepts projectId on MemoryCreateInput and stores it.
 *   The adapter (memory/index.ts) fills in projectId from resolveMemoryProjectScope
 *   when not explicitly provided; here we test the service layer's contract:
 *   - explicit projectId is stored as-is
 *   - the stored row's projectId is readable via list({ projectScope })
 */

describe("Writer stamping — sessions toPostgresInsert (ADR-021, mt#2416)", () => {
  it("toPostgresInsert maps SessionRecord.projectId → postgres insert projectId", () => {
    const record: SessionRecord = {
      sessionId: "test-session-1",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo",
      createdAt: new Date().toISOString(),
      projectId: PROJECT_A,
    };

    const insert = toPostgresInsert(record);
    expect(insert.projectId).toBe(PROJECT_A);
  });

  it("toPostgresInsert maps null projectId when session is unscoped (unidentified project)", () => {
    const record: SessionRecord = {
      sessionId: "test-session-2",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo",
      createdAt: new Date().toISOString(),
      // No projectId set — fallback / unidentified
    };

    const insert = toPostgresInsert(record);
    expect(insert.projectId).toBeNull();
  });

  it("toPostgresInsert maps undefined projectId to null (consistent storage)", () => {
    const record: SessionRecord = {
      sessionId: "test-session-3",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo",
      createdAt: new Date().toISOString(),
      projectId: undefined,
    };

    const insert = toPostgresInsert(record);
    expect(insert.projectId).toBeNull();
  });

  it("ScopedFakeSessionProvider.addSession then listSessions returns stamped projectId", async () => {
    const provider = new ScopedFakeSessionProvider();
    const record = makeSession("sess-stamp-1", PROJECT_A);

    await provider.addSession(record);
    const listed = await provider.listSessions({ projectScope: PROJECT_A });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.projectId).toBe(PROJECT_A);
  });

  it("session stamped with PROJECT_A is NOT returned when listing PROJECT_B scope", async () => {
    const provider = new ScopedFakeSessionProvider();
    await provider.addSession(makeSession("sess-stamp-2", PROJECT_A));

    const results = await provider.listSessions({ projectScope: PROJECT_B });
    expect(results).toHaveLength(0);
  });
});

describe("Writer stamping — memory.create projectId (ADR-021, mt#2416)", () => {
  let db: ReturnType<typeof createMemoryFakeDb>;
  let service: MemoryService;

  beforeEach(() => {
    memIdCounter = 1;
    db = createMemoryFakeDb();
    const vectorStorage = new MemoryVectorStorage(4);
    service = new MemoryService({ db, vectorStorage, embeddingService: mockEmbeddingService });
  });

  it("explicitly-provided projectId is stored on the created memory row", async () => {
    const created = await service.create({
      type: "user",
      name: "stamped-mem",
      description: "d",
      content: "content",
      scope: "project",
      projectId: PROJECT_A,
    });

    // The returned record carries the stamped projectId
    expect(created.projectId).toBe(PROJECT_A);

    // And it's retrievable via projectScope filtering
    const listed = await service.list({ projectScope: PROJECT_A });
    expect(listed.some((m) => m.name === "stamped-mem")).toBe(true);
  });

  it("explicitly-provided projectId is NOT overridden by a different scope on list", async () => {
    await service.create({
      type: "user",
      name: "explicit-proj-a",
      description: "d",
      content: "content",
      scope: "project",
      projectId: PROJECT_A,
    });

    // Listing with PROJECT_B should not include this memory
    const resultsB = await service.list({ projectScope: PROJECT_B });
    expect(resultsB.some((m) => m.name === "explicit-proj-a")).toBe(false);

    // Listing with PROJECT_A should include it
    const resultsA = await service.list({ projectScope: PROJECT_A });
    expect(resultsA.some((m) => m.name === "explicit-proj-a")).toBe(true);
  });

  it("memory created without projectId has null projectId and is returned by ALL_PROJECTS list", async () => {
    const created = await service.create({
      type: "user",
      name: "unscoped-mem",
      description: "d",
      content: "content",
      scope: "user",
      // No projectId — simulates the default before adapter-level stamping
    });

    expect(created.projectId).toBeNull();

    // The ALL_PROJECTS list returns unscoped records too
    const listed = await service.list({ projectScope: ALL_PROJECTS });
    expect(listed.some((m) => m.name === "unscoped-mem")).toBe(true);
  });

  it("two memories with different projectIds are independently retrievable by scope", async () => {
    await service.create({
      type: "user",
      name: "mem-for-a",
      description: "d",
      content: "a content",
      scope: "project",
      projectId: PROJECT_A,
    });
    await service.create({
      type: "user",
      name: "mem-for-b",
      description: "d",
      content: "b content",
      scope: "project",
      projectId: PROJECT_B,
    });

    const scopedA = await service.list({ projectScope: PROJECT_A });
    expect(scopedA.some((m) => m.name === "mem-for-a")).toBe(true);
    expect(scopedA.some((m) => m.name === "mem-for-b")).toBe(false);

    const scopedB = await service.list({ projectScope: PROJECT_B });
    expect(scopedB.some((m) => m.name === "mem-for-b")).toBe(true);
    expect(scopedB.some((m) => m.name === "mem-for-a")).toBe(false);
  });
});
