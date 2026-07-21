/**
 * DrizzleSessionRepository — ws#N short id minting + resolution (mt#2967).
 *
 * Two describe blocks:
 *
 *   - "mint" exercises the ACTUAL production minting path
 *     (`addSession()`'s select-then-insert + onConflictDoNothing + bounded
 *     retry) against a minimal fake `db` that models the real TOCTOU race —
 *     a short_id proposal can collide with a row that was invisible to the
 *     SELECT (not yet committed-and-visible) but IS enforced by the unique
 *     index at INSERT time. Modeled directly after
 *     `packages/domain/src/memory/memory-service.test.ts`'s "MemoryService —
 *     mem#N short id minting (mt#2966)" describe block (itself mirroring
 *     `packages/domain/src/ask/repository.test.ts`'s mt#2965 coverage) — the
 *     mt#2967 sibling task's equivalent coverage for `ws#N`.
 *
 *   - "resolution" exercises `getSession()`'s `resolveSessionIdInput` wiring:
 *     a `ws#N` short id, a full uuid, an 8+ char hex prefix, and a legacy
 *     custom session NAME (the sessions-specific fallback ask/memory don't
 *     need, since they're purely uuid-keyed) all resolve to the same
 *     canonical session row. `classifyEntityIdInput`/`resolveEntityIdPrefix`
 *     themselves are already exhaustively unit-tested in
 *     `../utils/id-prefix-resolver.test.ts` — these tests only need to prove
 *     `DrizzleSessionRepository.getSession()` wires into those primitives
 *     with the right table/column/prefix arguments and correctly threads
 *     the legacy-name fallback underneath them.
 *
 * @see mt#2967 — this file's originating task
 * @see mt#2966 PR #2134 — the memory sibling this file's mint tests mirror
 */

import { describe, it, expect } from "bun:test";
import { DrizzleSessionRepository } from "./drizzle-session-repository";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? `sess-uuid-${Math.random().toString(36).slice(2)}`,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mint tests — fake db modeling the real short_id TOCTOU race (mirrors
// memory-service.test.ts's createFakeMemoryDb).
// ---------------------------------------------------------------------------

interface FakeSessionRow {
  sessionId: string;
  shortId: string;
  [key: string]: unknown;
}

function createFakeMintDb(opts: { preClaimedShortIds?: string[] } = {}) {
  // `visible` — short ids a SELECT can currently see (committed rows).
  const visible = new Set<string>();
  // `claimed` — short ids the unique index will reject an INSERT for,
  // including ones not yet visible to a SELECT (the race window).
  const claimed = new Set<string>(opts.preClaimedShortIds ?? []);
  let insertAttempts = 0;
  let orderByLimitCalls = 0;
  const rowsBySessionId = new Map<string, FakeSessionRow>();

  const db = {
    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          const allVisibleRows = () => Array.from(visible).map((shortId) => ({ shortId }));
          return {
            where(cond: unknown) {
              void cond;
              const rows = allVisibleRows();
              return {
                // Mirrors nextSessionShortId's targeted `ORDER BY ... LIMIT 1`
                // query: sort descending by the numeric suffix — the same
                // ordering `(substring(short_id from 4))::bigint DESC` would
                // produce — so `top[0]` at the call site picks the max.
                orderBy(_order: unknown) {
                  const sorted = [...rows].sort((a, b) => {
                    const na = Number(a.shortId.split("#")[1]);
                    const nb = Number(b.shortId.split("#")[1]);
                    return nb - na;
                  });
                  return {
                    limit(n: number) {
                      orderByLimitCalls += 1;
                      return Promise.resolve(sorted.slice(0, n));
                    },
                  };
                },
                then(resolve: (v: unknown[]) => void, reject?: (err: unknown) => void) {
                  Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
            then(resolve: (v: unknown[]) => void, reject?: (err: unknown) => void) {
              Promise.resolve(allVisibleRows()).then(resolve, reject);
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          return {
            onConflictDoNothing(_opts?: unknown) {
              return {
                returning(_shape?: unknown) {
                  insertAttempts += 1;
                  const shortId = row["shortId"] as string;
                  const sessionId = row["sessionId"] as string;
                  if (claimed.has(shortId)) {
                    // A concurrent writer already holds this short_id. By
                    // the time we retry, its commit is now visible to a
                    // fresh SELECT.
                    visible.add(shortId);
                    return Promise.resolve([]);
                  }
                  const inserted: FakeSessionRow = { ...row, sessionId, shortId };
                  claimed.add(shortId);
                  visible.add(shortId);
                  rowsBySessionId.set(sessionId, inserted);
                  return Promise.resolve([{ sessionId }]);
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as never,
    get insertAttempts() {
      return insertAttempts;
    },
    get orderByLimitCalls() {
      return orderByLimitCalls;
    },
    get rowsBySessionId() {
      return rowsBySessionId;
    },
  };
}

describe("DrizzleSessionRepository — ws#N short id minting (mt#2967)", () => {
  it("mints ws#1 then ws#2 on sequential addSession calls against the real minting path", async () => {
    const fake = createFakeMintDb();
    const repo = new DrizzleSessionRepository(fake.db);

    await repo.addSession(makeRecord({ sessionId: "uuid-a" }));
    await repo.addSession(makeRecord({ sessionId: "uuid-b" }));

    expect(fake.rowsBySessionId.get("uuid-a")?.shortId).toBe("ws#1");
    expect(fake.rowsBySessionId.get("uuid-b")?.shortId).toBe("ws#2");
    // REGRESSION: uuid id is still the PK — unaffected by short-id minting.
    expect(fake.rowsBySessionId.get("uuid-a")?.sessionId).toBe("uuid-a");
  });

  it("mints ws#3 on the third sequential addSession call", async () => {
    const fake = createFakeMintDb();
    const repo = new DrizzleSessionRepository(fake.db);

    await repo.addSession(makeRecord({ sessionId: "uuid-a" }));
    await repo.addSession(makeRecord({ sessionId: "uuid-b" }));
    await repo.addSession(makeRecord({ sessionId: "uuid-c" }));

    expect(fake.rowsBySessionId.get("uuid-c")?.shortId).toBe("ws#3");
  });

  it("exercises the real-DB-optimized ORDER BY/LIMIT path, not just the fallback", async () => {
    // This fake implements the full targeted-query chain, so
    // nextSessionShortId's optimized path (try block) should succeed on
    // every call — never falling through to the unfiltered-select
    // fallback. Asserting on `orderByLimitCalls` (not just the minted
    // shortId) proves the optimized path actually ran, since both paths
    // return the same value and a passing shortId assertion alone can't
    // distinguish "optimized path ran" from "silently fell back".
    const fake = createFakeMintDb();
    const repo = new DrizzleSessionRepository(fake.db);

    await repo.addSession(makeRecord({ sessionId: "uuid-a" }));
    await repo.addSession(makeRecord({ sessionId: "uuid-b" }));

    expect(fake.orderByLimitCalls).toBe(2);
  });

  it("retries past a short_id collision invisible to the SELECT snapshot (TOCTOU race)", async () => {
    // "ws#1" is already claimed by a concurrent writer but not yet visible
    // to a fresh SELECT — the exact race the retry loop exists to handle.
    const fake = createFakeMintDb({ preClaimedShortIds: ["ws#1"] });
    const repo = new DrizzleSessionRepository(fake.db);

    await repo.addSession(makeRecord({ sessionId: "uuid-a" }));

    expect(fake.rowsBySessionId.get("uuid-a")?.shortId).toBe("ws#2");
    // Read live (a getter) AFTER the operation — destructuring it up front
    // would capture the value at construction time (0), not after retries.
    expect(fake.insertAttempts).toBe(2); // first attempt collided, second succeeded
  });

  it("throws after MAX_RETRIES exhausted when every proposed id keeps colliding", async () => {
    const fake = createFakeMintDb({
      preClaimedShortIds: ["ws#1", "ws#2", "ws#3", "ws#4", "ws#5"],
    });
    const repo = new DrizzleSessionRepository(fake.db);

    await expect(repo.addSession(makeRecord({ sessionId: "uuid-a" }))).rejects.toThrow(
      /unique session short id/i
    );
  });
});

// ---------------------------------------------------------------------------
// Resolution tests — getSession() resolving ws#N / uuid / hex-prefix /
// legacy-name input, all to the same canonical session row.
// ---------------------------------------------------------------------------

/**
 * A fake db supporting exactly the two call SHAPES `getSession()` can issue:
 *
 *  - resolveEntityIdPrefix's candidate query: `.select(shape).from(table)
 *    .where(cond)`, AWAITED DIRECTLY (no `.limit()`) — used for the ws#N /
 *    hex-prefix resolution paths only.
 *  - the final full-row fetch: `.select().from(table).where(eq(...))
 *    .limit(1)` — always issued once resolution (or passthrough) yields a
 *    canonical id.
 *
 * Distinguishing them by USAGE (whether `.limit()` gets called) rather than
 * by interpreting the opaque drizzle `cond`/`shape` values lets this fake
 * stay simple: each test supplies exactly the candidate row(s) and the
 * canonical full row it expects for its scenario — `classifyEntityIdInput` /
 * `resolveEntityIdPrefix` themselves are exhaustively covered elsewhere
 * (`../utils/id-prefix-resolver.test.ts`).
 */
function createFakeGetSessionDb(opts: {
  /** Rows returned by the FIRST (candidate) select call, when one occurs. */
  candidates?: Array<{ id: string }>;
  /** The full row returned by the final full-row fetch. */
  fullRow: Record<string, unknown> | null;
}) {
  const db = {
    select(shape?: unknown) {
      const isFullRowSelect = shape === undefined;
      return {
        from(_table: unknown) {
          return {
            where(_cond: unknown) {
              return {
                then(resolve: (v: unknown[]) => void, reject?: (err: unknown) => void) {
                  // Direct-await usage: resolveEntityIdPrefix's candidate query.
                  Promise.resolve(opts.candidates ?? []).then(resolve, reject);
                },
                limit(_n: number) {
                  // getSession's final full-row fetch.
                  void isFullRowSelect;
                  return Promise.resolve(opts.fullRow ? [opts.fullRow] : []);
                },
              };
            },
          };
        },
      };
    },
  };
  return db as unknown as never;
}

function fullRowFor(sessionId: string, shortId: string | null): Record<string, unknown> {
  return {
    sessionId,
    shortId,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(0),
    taskId: null,
    prBranch: null,
    prApproved: null,
    prState: null,
    backendType: null,
    pullRequest: null,
    lastActivityAt: null,
    lastCommitHash: null,
    lastCommitMessage: null,
    commitCount: null,
    status: null,
    agentId: null,
    projectId: null,
    interfaceBinding: null,
  };
}

describe("DrizzleSessionRepository — ws#N / uuid / hex-prefix / name resolution (mt#2967)", () => {
  const CANONICAL_UUID = "6f9a3b10-1111-4a22-8888-abcdefabcdef";

  it("resolves ws#7 to the row carrying that short id", async () => {
    const db = createFakeGetSessionDb({
      candidates: [{ id: CANONICAL_UUID }],
      fullRow: fullRowFor(CANONICAL_UUID, "ws#7"),
    });
    const repo = new DrizzleSessionRepository(db);

    const session = await repo.getSession("ws#7");

    expect(session?.sessionId).toBe(CANONICAL_UUID);
    expect(session?.shortId).toBe("ws#7");
  });

  it("passes a full uuid straight through (no resolution query, identical to pre-mt#2967 behavior)", async () => {
    const db = createFakeGetSessionDb({
      fullRow: fullRowFor(CANONICAL_UUID, "ws#7"),
    });
    const repo = new DrizzleSessionRepository(db);

    const session = await repo.getSession(CANONICAL_UUID);

    expect(session?.sessionId).toBe(CANONICAL_UUID);
  });

  it("resolves an 8+ char hex prefix of the uuid to the same row", async () => {
    const db = createFakeGetSessionDb({
      candidates: [{ id: CANONICAL_UUID }],
      fullRow: fullRowFor(CANONICAL_UUID, "ws#7"),
    });
    const repo = new DrizzleSessionRepository(db);

    const session = await repo.getSession(CANONICAL_UUID.slice(0, 8));

    expect(session?.sessionId).toBe(CANONICAL_UUID);
  });

  it("falls through UNCHANGED for a legacy custom session name (regression)", async () => {
    // "my-session" is neither uuid-shaped, ws#N-shaped, nor an 8+ char hex
    // fragment -- classifyEntityIdInput reports "invalid", and
    // resolveSessionIdInput falls through to the raw exact-match query
    // exactly as it did before mt#2967 (no resolveEntityIdPrefix call, no
    // candidate query at all).
    const db = createFakeGetSessionDb({
      fullRow: fullRowFor("my-session", null),
    });
    const repo = new DrizzleSessionRepository(db);

    const session = await repo.getSession("my-session");

    expect(session?.sessionId).toBe("my-session");
  });

  it("returns null for a ws#N input with no matching row (never falls through to a name lookup)", async () => {
    const db = createFakeGetSessionDb({ candidates: [], fullRow: null });
    const repo = new DrizzleSessionRepository(db);

    const session = await repo.getSession("ws#999");

    expect(session).toBeNull();
  });
});
