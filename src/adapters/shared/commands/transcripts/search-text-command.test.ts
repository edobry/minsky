import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptSearchTextCommand } from "./search-text-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

const COMMAND_ID = "transcripts.search-text";

// ── Fake DB modelling the three query shapes execute() drives ────────────────
// 1. searchText turn query (select has turnIndex) → turn rows
// 2. getMessageCounts (select has agentSessionId + count) → count rows
// 3. assessWindowCoverage (select has only count) → a single { count } row
type FakeRow = Record<string, unknown>;

function makeFakeDb(turnRows: FakeRow[], coverageCount: number) {
  let cols: Record<string, unknown> = {};
  const resolve = (n?: number): Promise<FakeRow[]> => {
    if ("turnIndex" in cols)
      return Promise.resolve(n !== undefined ? turnRows.slice(0, n) : turnRows);
    const keys = Object.keys(cols);
    if (keys.length === 1 && "count" in cols) return Promise.resolve([{ count: coverageCount }]);
    // getMessageCounts: one count row per distinct session in turnRows
    const ids = [...new Set(turnRows.map((r) => r.agentSessionId))];
    return Promise.resolve(ids.map((id) => ({ agentSessionId: id, count: 1 })));
  };
  const limit = (n: number) => resolve(n);
  const orderBy = () => ({ limit, then: (r: (v: FakeRow[]) => unknown) => resolve().then(r) });
  const groupBy = () => ({ then: (r: (v: FakeRow[]) => unknown) => resolve().then(r) });
  const where = () => ({
    orderBy,
    groupBy,
    limit,
    then: (r: (v: FakeRow[]) => unknown) => resolve().then(r),
  });
  const innerJoin = () => ({ where, orderBy });
  const from = () => ({ innerJoin, where, orderBy, limit, groupBy });
  const select = (c: Record<string, unknown>) => {
    cols = c;
    return { from };
  };
  return { select } as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

function makeContainerWithDb(db: unknown): AppContainerInterface {
  const provider = { getDatabaseConnection: async () => db };
  return {
    has: (key: string) => key === "persistence",
    get: (_key: string) => provider,
  } as unknown as AppContainerInterface;
}

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — only `has()` and `get()` are read. Defining a
 * proper subset type rather than casting through `unknown` keeps test seams
 * type-checked (per `feedback_no_test_only_casts`).
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.search-text command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptSearchTextCommand(undefined, registry);
  });

  function getCommand() {
    const command = registry.getCommand(COMMAND_ID);
    if (!command) {
      throw new Error(`${COMMAND_ID} should be registered`);
    }
    return command;
  }

  describe("registration", () => {
    test(`registers under id ${COMMAND_ID}`, () => {
      const command = getCommand();
      expect(command.name).toBe("search-text");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions full-text search and ts_rank", () => {
      const command = getCommand();
      expect(command.description).toContain("full-text search");
      expect(command.description).toContain("ts_rank");
    });

    test("declares query, limit, role, from, to, and session parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.query).toBeDefined();
      expect(params.limit).toBeDefined();
      expect(params.role).toBeDefined();
      expect(params.from).toBeDefined();
      expect(params.to).toBeDefined();
      expect(params.session).toBeDefined();
    });

    test("query is required; limit defaults to 10; optional params have no default", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.query?.required).toBe(true);
      expect(params.limit?.defaultValue).toBe(10);
      expect(params.role?.defaultValue).toBeUndefined();
      expect(params.from?.defaultValue).toBeUndefined();
      expect(params.to?.defaultValue).toBeUndefined();
      expect(params.session?.defaultValue).toBeUndefined();
    });
  });

  describe("DI guard", () => {
    test("throws when DI container is missing 'persistence'", async () => {
      // The command only reads .has()/.get() from the container; ContainerSubset
      // narrows the test seam to those two members rather than constructing a
      // full AppContainerInterface stub.
      const containerWithoutPersistence: ContainerSubset = {
        has: (_key: string) => false,
        get: (_key: string) => {
          throw new Error("not bound");
        },
      };
      const ctx = {
        interface: "cli" as const,
        container: containerWithoutPersistence as AppContainerInterface,
      };
      await expect(getCommand().execute({ query: "hello" }, ctx)).rejects.toThrow(/persistence/);
    });
  });

  describe("execute output shape (mt#2319 SC#4)", () => {
    const turnRow = {
      agentSessionId: "s1",
      turnIndex: 0,
      userText: "hi",
      assistantText: "yo",
      startedAt: new Date("2026-06-06"),
      endedAt: null,
      isSpawnBoundary: false,
      score: 0.9,
      sessionStartedAt: new Date("2026-06-02"),
      sessionModel: "claude",
      relatedTaskIds: [],
      relatedPrNumbers: [],
    };

    test("returns { results } with NO coverage key when no date window is given", async () => {
      const ctx = {
        interface: "cli" as const,
        container: makeContainerWithDb(makeFakeDb([turnRow], 3)),
      };
      const resp = (await getCommand().execute({ query: "hi" }, ctx)) as {
        results: unknown[];
        coverage?: unknown;
      };
      expect(Array.isArray(resp.results)).toBe(true);
      expect(resp.results).toHaveLength(1);
      // No window → coverage is never assessed, so the key is absent.
      expect("coverage" in resp).toBe(false);
    });

    test("returns { results, coverage } when a windowed query has un-indexed sessions", async () => {
      const ctx = {
        interface: "cli" as const,
        container: makeContainerWithDb(makeFakeDb([turnRow], 3)),
      };
      const resp = (await getCommand().execute(
        { query: "hi", from: "2026-06-05", to: "2026-06-07" },
        ctx
      )) as { results: unknown[]; coverage?: { unindexedSessionsInWindow: number } };
      expect(resp.results).toHaveLength(1);
      expect(resp.coverage).toBeDefined();
      expect(resp.coverage?.unindexedSessionsInWindow).toBe(3);
    });

    test("omits coverage when a windowed query has no un-indexed sessions", async () => {
      const ctx = {
        interface: "cli" as const,
        container: makeContainerWithDb(makeFakeDb([turnRow], 0)),
      };
      const resp = (await getCommand().execute(
        { query: "hi", from: "2026-06-05", to: "2026-06-07" },
        ctx
      )) as { results: unknown[]; coverage?: unknown };
      expect(resp.results).toHaveLength(1);
      expect("coverage" in resp).toBe(false);
    });
  });
});
