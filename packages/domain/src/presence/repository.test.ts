/**
 * Presence claim repository tests (mt#2562).
 *
 * Tests:
 *   1. upsert insert-vs-refresh: no duplicate on repeat touch for same (kind, id, actor).
 *   2. multi-actor set on one subject: two actors → two claims in listClaims.
 *   3. listClaims stale-filtering: stale claims are annotated with stale=true.
 *   4. reapStale: deletes claims older than the threshold; leaves fresh claims.
 *   5. toPresenceClaim mapping: row → domain shape (pure, no DB).
 *
 * All tests use an in-memory fake "DB" that implements the drizzle query builder
 * surface used by DrizzlePresenceClaimRepository. No real Postgres required.
 *
 * Write-path-without-session tests live in src/mcp/server-presence-write.test.ts
 * (alongside the server.ts write path).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PresenceClaimRecord } from "../storage/schemas/presence-claims-schema";
import {
  DrizzlePresenceClaimRepository,
  buildPresenceClaimRepository,
  toPresenceClaim,
} from "./repository";
import type { UpsertPresenceClaimInput } from "./types";
import { PRESENCE_CLAIM_TTL_MS } from "./types";

// ---------------------------------------------------------------------------
// In-memory row type (mirrors PresenceClaimRecord structure)
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  subjectKind: string;
  subjectId: string;
  actorId: string;
  ccConversationId: string | null;
  tty: string | null;
  host: string | null;
  sessionId: string | null;
  projectId: string | null;
  claimedAt: Date;
  lastRefreshedAt: Date;
}

// ---------------------------------------------------------------------------
// Fake DB implementing the drizzle query builder surface
// ---------------------------------------------------------------------------

/**
 * A smarter fake DB that intercepts the actual where arguments passed to the
 * drizzle builder and uses column value matching. Since drizzle uses PgDialect
 * to render SQL, we short-circuit by using a row-based store and injecting the
 * filter at the `where()` call based on column names extracted from the
 * drizzle expression.
 *
 * Strategy: we record INSERT in a plain Map keyed by (subjectKind, subjectId, actorId),
 * then SELECT/DELETE filter based on the arguments to `eq()` calls by inspecting
 * the drizzle column's `.name` property and the value passed.
 */
function createSmartFakeDb() {
  const rows: Map<string, FakeRow> = new Map();
  let idCounter = 100;

  function rowKey(subjectKind: string, subjectId: string, actorId: string) {
    return `${subjectKind}::${subjectId}::${actorId}`;
  }

  const db = {
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: (opts: { target: unknown[]; set: Record<string, unknown> }) => ({
          returning: async () => {
            const now = (vals.lastRefreshedAt as Date | undefined) ?? new Date();
            const claimedAt = (vals.claimedAt as Date | undefined) ?? now;
            const subjectKind = vals.subjectKind as string;
            const subjectId = vals.subjectId as string;
            const actorId = vals.actorId as string;
            const key = rowKey(subjectKind, subjectId, actorId);

            const existing = rows.get(key);
            if (existing) {
              // Update mutable fields from onConflictSet
              const set = opts.set as Record<string, unknown>;
              const updated: FakeRow = {
                ...existing,
                ccConversationId: (set.ccConversationId as string | null | undefined) ?? null,
                tty: (set.tty as string | null | undefined) ?? null,
                host: (set.host as string | null | undefined) ?? null,
                sessionId: (set.sessionId as string | null | undefined) ?? null,
                projectId: (set.projectId as string | null | undefined) ?? null,
                lastRefreshedAt: (set.lastRefreshedAt as Date | undefined) ?? now,
              };
              rows.set(key, updated);
              return [updated as unknown as PresenceClaimRecord];
            } else {
              const row: FakeRow = {
                id: `fake-id-${idCounter++}`,
                subjectKind,
                subjectId,
                actorId,
                ccConversationId: (vals.ccConversationId as string | null | undefined) ?? null,
                tty: (vals.tty as string | null | undefined) ?? null,
                host: (vals.host as string | null | undefined) ?? null,
                sessionId: (vals.sessionId as string | null | undefined) ?? null,
                projectId: (vals.projectId as string | null | undefined) ?? null,
                claimedAt,
                lastRefreshedAt: now,
              };
              rows.set(key, row);
              return [row as unknown as PresenceClaimRecord];
            }
          },
        }),
      }),
    }),

    select: () => ({
      from: (_table: unknown) => ({
        where: (condition: unknown) => {
          // Extract filter info from drizzle `and(eq(...), eq(...))` by rendering
          // to SQL or by inspecting the condition object.
          // We use a pragmatic approach: extract subjectKind and subjectId from
          // the QueryBuilder's underlying structure. Since drizzle stores column
          // refs and values, we look at the `.left.name` / `.right.value` shape.
          let filterKind: string | null = null;
          let filterId: string | null = null;
          extractEqFilters(condition, (colName, val) => {
            if (colName === "subject_kind") filterKind = val;
            if (colName === "subject_id") filterId = val;
          });

          const filtered = [...rows.values()].filter((r) => {
            if (filterKind !== null && r.subjectKind !== filterKind) return false;
            if (filterId !== null && r.subjectId !== filterId) return false;
            return true;
          });

          return {
            orderBy: (_col: unknown) => {
              const sorted = [...filtered].sort(
                (a, b) => a.lastRefreshedAt.getTime() - b.lastRefreshedAt.getTime()
              );
              return Promise.resolve(sorted as unknown as PresenceClaimRecord[]);
            },
          };
        },
      }),
    }),

    delete: (_table: unknown) => ({
      where: (condition: unknown) => ({
        returning: async () => {
          // Extract lt condition — look for the cutoff date
          let cutoff: Date | null = null;
          extractLtFilter(condition, (val) => {
            cutoff = val;
          });

          const deleted: FakeRow[] = [];
          for (const [key, row] of rows.entries()) {
            if (cutoff !== null && row.lastRefreshedAt < cutoff) {
              deleted.push(row);
              rows.delete(key);
            }
          }
          return deleted.map((r) => ({ id: r.id }));
        },
      }),
    }),

    // Expose the raw rows for inspection in tests
    __rows: () => [...rows.values()],
  };

  return db;
}

// ---------------------------------------------------------------------------
// Drizzle expression inspectors
// ---------------------------------------------------------------------------

/**
 * Return the string value of a drizzle SQL separator chunk, or null.
 *
 * Drizzle v0.44 stores template-literal string parts as `StringChunk` objects
 * whose `.value` property is an ARRAY of strings (not a plain string). Older
 * versions stored them as plain strings. This helper handles both forms.
 */
function sepChunkString(sep: unknown): string | null {
  if (sep === null || sep === undefined) return null;
  if (typeof sep === "string") return sep;
  if (typeof sep === "object") {
    const v = (sep as Record<string, unknown>)["value"];
    if (typeof v === "string") return v;
    // drizzle v0.44: StringChunk.value is an array of strings
    if (Array.isArray(v)) {
      return (v as unknown[]).filter((s): s is string => typeof s === "string").join("");
    }
  }
  return null;
}

/**
 * Walk a drizzle `and(eq(col, val), eq(col, val))` tree and call `cb` for
 * each `eq(col, val)` leaf where col is a PgColumn. Handles nested `and`.
 *
 * In drizzle v0.44 the `and(eq1, eq2)` result has queryChunks:
 *   [StringChunk("("), SQL([eq1, StringChunk(" and "), eq2]), StringChunk(")")]
 *
 * And each `eq(col, val)` SQL object has queryChunks:
 *   [StringChunk(""), Column{name,table}, StringChunk(" = "), Param{value}, StringChunk("")]
 *
 * StringChunk.value is an array of strings in drizzle v0.44 (NOT a plain string).
 */
function extractEqFilters(condition: unknown, cb: (colName: string, val: string) => void): void {
  if (!condition || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;

  if (Array.isArray(c["queryChunks"])) {
    const chunks = c["queryChunks"] as Array<unknown>;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Column objects: `name` is a string (the SQL column name) and `table` is set.
      // Drizzle v0.44 PgColumn shape.
      if (
        chunk &&
        typeof chunk === "object" &&
        typeof (chunk as Record<string, unknown>)["name"] === "string" &&
        (chunk as Record<string, unknown>)["table"] !== undefined
      ) {
        const colName = (chunk as Record<string, unknown>)["name"] as string;
        // Pattern: [Column, StringChunk(" = "), Param]
        // Use sepChunkString() to handle both plain-string and StringChunk separators.
        const sep = chunks[i + 1];
        const param = chunks[i + 2];
        const sepStr = sepChunkString(sep);
        if (sepStr !== null && sepStr.includes("=") && param && typeof param === "object") {
          const v = (param as Record<string, unknown>)["value"];
          if (v !== undefined) cb(colName, String(v));
        }
      }

      // Recurse into nested SQL objects (handles `and(eq1, eq2)` → wrapping SQL nesting)
      if (
        chunk &&
        typeof chunk === "object" &&
        Array.isArray((chunk as Record<string, unknown>)["queryChunks"])
      ) {
        extractEqFilters(chunk, cb);
      }
    }
  }
}

/**
 * Walk a drizzle `lt(col, val)` tree and extract the Date value.
 * Same recursive strategy as extractEqFilters.
 */
function extractLtFilter(condition: unknown, cb: (val: Date) => void): void {
  if (!condition || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;

  if (Array.isArray(c["queryChunks"])) {
    const chunks = c["queryChunks"] as Array<unknown>;
    for (const chunk of chunks) {
      if (chunk instanceof Date) {
        cb(chunk);
        return;
      }
      if (chunk && typeof chunk === "object" && chunk !== null) {
        const v = (chunk as Record<string, unknown>)["value"];
        if (v instanceof Date) {
          cb(v);
          return;
        }
        // Recurse into nested SQL
        if (Array.isArray((chunk as Record<string, unknown>)["queryChunks"])) {
          let found = false;
          extractLtFilter(chunk, (d) => {
            if (!found) {
              found = true;
              cb(d);
            }
          });
          if (found) return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// Actor-id string used in toPresenceClaim tests. Extracted here because the
// no-magic-string-duplication rule fires when the same string literal appears
// in two or more test assertions.
const TEST_ACTOR_ID = "claude-code:claude-sonnet-4";

// ---------------------------------------------------------------------------
// Tests: toPresenceClaim (pure unit, no DB)
// ---------------------------------------------------------------------------

describe("toPresenceClaim", () => {
  test("maps all required fields from a PresenceClaimRecord row", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const row: PresenceClaimRecord = {
      id: "uuid-1",
      subjectKind: "task",
      subjectId: "mt#2562",
      actorId: TEST_ACTOR_ID,
      ccConversationId: "conv-abc",
      tty: "/dev/ttys003",
      host: "macbook-pro.local",
      sessionId: "session-uuid",
      projectId: "proj-uuid",
      claimedAt: now,
      lastRefreshedAt: now,
    };

    const claim = toPresenceClaim(row);

    expect(claim.id).toBe("uuid-1");
    expect(claim.subjectKind).toBe("task");
    expect(claim.subjectId).toBe("mt#2562");
    expect(claim.actorId).toBe(TEST_ACTOR_ID);
    expect(claim.ccConversationId).toBe("conv-abc");
    expect(claim.tty).toBe("/dev/ttys003");
    expect(claim.host).toBe("macbook-pro.local");
    expect(claim.sessionId).toBe("session-uuid");
    expect(claim.projectId).toBe("proj-uuid");
    expect(claim.claimedAt).toBe("2026-06-26T12:00:00.000Z");
    expect(claim.lastRefreshedAt).toBe("2026-06-26T12:00:00.000Z");
  });

  test("maps nullable where-context fields to undefined when null", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const row: PresenceClaimRecord = {
      id: "uuid-2",
      subjectKind: "task",
      subjectId: "mt#2562",
      actorId: TEST_ACTOR_ID,
      ccConversationId: null,
      tty: null,
      host: null,
      sessionId: null,
      projectId: null,
      claimedAt: now,
      lastRefreshedAt: now,
    };

    const claim = toPresenceClaim(row);

    expect(claim.ccConversationId).toBeUndefined();
    expect(claim.tty).toBeUndefined();
    expect(claim.host).toBeUndefined();
    expect(claim.sessionId).toBeUndefined();
    expect(claim.projectId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: DrizzlePresenceClaimRepository with smart fake DB
// ---------------------------------------------------------------------------

describe("DrizzlePresenceClaimRepository", () => {
  let db: ReturnType<typeof createSmartFakeDb>;
  let repo: DrizzlePresenceClaimRepository;

  beforeEach(() => {
    db = createSmartFakeDb();
    // Cast to PostgresJsDatabase — the fake implements the subset we use
    repo = new DrizzlePresenceClaimRepository(db as unknown as PostgresJsDatabase);
  });

  // -------------------------------------------------------------------------
  // 1. Upsert: insert-vs-refresh (no duplicate on repeat touch)
  // -------------------------------------------------------------------------

  describe("upsertClaim — insert-vs-refresh semantics", () => {
    test("inserts a new row on first upsert", async () => {
      const input: UpsertPresenceClaimInput = {
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-1",
        ccConversationId: "conv-abc",
      };

      const claim = await repo.upsertClaim(input);

      expect(claim.subjectKind).toBe("task");
      expect(claim.subjectId).toBe("mt#2562");
      expect(claim.actorId).toBe("actor-1");
      expect(claim.ccConversationId).toBe("conv-abc");
      expect(claim.claimedAt).toBeDefined();
      expect(claim.lastRefreshedAt).toBeDefined();

      // Exactly one row in storage
      expect(db.__rows()).toHaveLength(1);
    });

    test("refreshes lastRefreshedAt on repeat touch without creating a duplicate", async () => {
      const input: UpsertPresenceClaimInput = {
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-1",
        ccConversationId: "conv-abc",
      };

      const claim1 = await repo.upsertClaim(input);

      // Simulate time passing
      await new Promise((r) => setTimeout(r, 5));

      const claim2 = await repo.upsertClaim({ ...input, ccConversationId: "conv-xyz" });

      // Still exactly one row
      expect(db.__rows()).toHaveLength(1);

      // claimed_at is unchanged (set at insert time)
      expect(claim2.claimedAt).toBe(claim1.claimedAt);

      // lastRefreshedAt should be >= claimedAt (may be equal if same ms)
      expect(new Date(claim2.lastRefreshedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(claim2.claimedAt).getTime()
      );

      // Where-context updated to new value
      expect(claim2.ccConversationId).toBe("conv-xyz");
    });

    test("claimedAt is preserved across multiple refreshes", async () => {
      const input: UpsertPresenceClaimInput = {
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-1",
      };

      const first = await repo.upsertClaim(input);
      await new Promise((r) => setTimeout(r, 5));
      const second = await repo.upsertClaim(input);
      await new Promise((r) => setTimeout(r, 5));
      const third = await repo.upsertClaim(input);

      // claimed_at always matches the first insert
      expect(second.claimedAt).toBe(first.claimedAt);
      expect(third.claimedAt).toBe(first.claimedAt);

      // Only one row ever created
      expect(db.__rows()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Multi-actor set on one subject
  // -------------------------------------------------------------------------

  describe("upsertClaim — multi-actor set semantics", () => {
    test("two actors on same subject create two separate rows", async () => {
      await repo.upsertClaim({
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-1",
        ccConversationId: "conv-A",
      });
      await repo.upsertClaim({
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-2",
        ccConversationId: "conv-B",
      });

      const allRows = db.__rows();
      expect(allRows).toHaveLength(2);

      const actorIds = allRows.map((r) => r.actorId).sort();
      expect(actorIds).toEqual(["actor-1", "actor-2"]);
    });

    test("different subjects produce separate rows even with same actor", async () => {
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "actor-1" });
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2563", actorId: "actor-1" });

      expect(db.__rows()).toHaveLength(2);
    });

    test("different subject kinds with same id and actor produce separate rows", async () => {
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "actor-1" });
      await repo.upsertClaim({ subjectKind: "session", subjectId: "mt#2562", actorId: "actor-1" });

      expect(db.__rows()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 3. listClaims — stale filtering
  // -------------------------------------------------------------------------

  describe("listClaims — stale annotation", () => {
    test("fresh claim (lastRefreshedAt within TTL) is annotated stale=false", async () => {
      await repo.upsertClaim({
        subjectKind: "task",
        subjectId: "mt#2562",
        actorId: "actor-1",
      });

      // TTL of 100ms — the claim was just inserted so it should be fresh
      const claims = await repo.listClaims("task", "mt#2562", 100 * 1000);
      expect(claims).toHaveLength(1);
      expect(claims[0]?.stale).toBe(false);
    });

    test("stale claim (lastRefreshedAt past TTL) is annotated stale=true", async () => {
      // Manually insert a row with an old lastRefreshedAt by injecting into the fake
      // eslint-disable-next-line custom/no-real-fs-in-tests -- computing a stale timestamp offset, not creating a path
      const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      // First upsert to get a row, then mutate it
      await repo.upsertClaim({
        subjectKind: "task",
        subjectId: "mt#9999",
        actorId: "actor-stale",
      });

      // Mutate the row's lastRefreshedAt to be 1 hour ago
      const injected = db.__rows();
      if (injected[0]) {
        (injected[0] as { lastRefreshedAt: Date }).lastRefreshedAt = oldTime;
      }

      // 15m TTL → claim created 1h ago is stale
      const claims = await repo.listClaims("task", "mt#9999", PRESENCE_CLAIM_TTL_MS);
      expect(claims).toHaveLength(1);
      expect(claims[0]?.stale).toBe(true);
    });

    test("listClaims returns only claims for the requested subject", async () => {
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "actor-1" });
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#9999", actorId: "actor-2" });

      const claims = await repo.listClaims("task", "mt#2562");
      expect(claims).toHaveLength(1);
      expect(claims[0]?.actorId).toBe("actor-1");
    });

    test("listClaims returns multiple actors for the same subject", async () => {
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "actor-1" });
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "actor-2" });

      const claims = await repo.listClaims("task", "mt#2562");
      expect(claims).toHaveLength(2);
      const actorIds = claims.map((c) => c.actorId).sort();
      expect(actorIds).toEqual(["actor-1", "actor-2"]);
    });

    test("listClaims returns empty array when no claims exist for subject", async () => {
      const claims = await repo.listClaims("task", "mt#nonexistent");
      expect(claims).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. reapStale
  // -------------------------------------------------------------------------

  describe("reapStale", () => {
    test("deletes claims older than the threshold and returns the count", async () => {
      // Insert a fresh claim
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "fresh" });

      // Insert a stale claim by mutating lastRefreshedAt
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "stale" });
      const staleRow = db.__rows().find((r) => r.actorId === "stale");
      if (staleRow) {
        // eslint-disable-next-line custom/no-real-fs-in-tests -- computing a stale timestamp offset, not creating a path
        staleRow.lastRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      }

      expect(db.__rows()).toHaveLength(2);

      // Reap claims older than 24h
      const reaped = await repo.reapStale(24 * 60 * 60 * 1000);

      expect(reaped).toBe(1);
      expect(db.__rows()).toHaveLength(1);
      expect(db.__rows()[0]?.actorId).toBe("fresh");
    });

    test("reapStale returns 0 when no claims are old enough", async () => {
      await repo.upsertClaim({ subjectKind: "task", subjectId: "mt#2562", actorId: "fresh" });

      const reaped = await repo.reapStale(24 * 60 * 60 * 1000);
      expect(reaped).toBe(0);
      expect(db.__rows()).toHaveLength(1);
    });

    test("reapStale deletes all rows older than threshold", async () => {
      for (let i = 0; i < 3; i++) {
        await repo.upsertClaim({
          subjectKind: "task",
          subjectId: "mt#2562",
          actorId: `stale-actor-${i}`,
        });
        const row = db.__rows().find((r) => r.actorId === `stale-actor-${i}`);
        if (row) {
          // eslint-disable-next-line custom/no-real-fs-in-tests -- computing a stale timestamp offset, not creating a path
          row.lastRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
        }
      }

      const reaped = await repo.reapStale(24 * 60 * 60 * 1000);
      expect(reaped).toBe(3);
      expect(db.__rows()).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: buildPresenceClaimRepository helper
// ---------------------------------------------------------------------------

describe("buildPresenceClaimRepository", () => {
  test("returns null when db is null", () => {
    expect(buildPresenceClaimRepository(null)).toBeNull();
  });

  test("returns null when db is undefined", () => {
    expect(buildPresenceClaimRepository(undefined)).toBeNull();
  });

  test("constructs unconditionally for any truthy db (no duck-type guard, mirrors buildAskRepository)", () => {
    // buildPresenceClaimRepository's doc comment (repository.ts) explicitly
    // documents this as a deliberate mt#2567 design decision: no duck-type
    // guard is needed since getDatabaseConnection() always returns a real
    // PostgresJsDatabase. The prior version of this test asserted a stricter
    // "lacks select method -> null" contract that was never implemented and
    // contradicts that documented decision (mt#2608) — verified against the
    // sibling buildAskRepository, which likewise constructs unconditionally.
    expect(buildPresenceClaimRepository({ insert: () => {} })).toBeInstanceOf(
      DrizzlePresenceClaimRepository
    );
  });

  test("returns a DrizzlePresenceClaimRepository when given a duck-typed db", () => {
    const fakeDb = { select: () => ({}) };
    const repo = buildPresenceClaimRepository(fakeDb);
    expect(repo).toBeInstanceOf(DrizzlePresenceClaimRepository);
  });
});

// ---------------------------------------------------------------------------
// Tests: write path fires without a session (the core gap — mt#2562)
// ---------------------------------------------------------------------------

describe("write path fires without a session (the core gap)", () => {
  /**
   * This test verifies the design contract: a PresenceClaimRepository.upsertClaim()
   * call requires ONLY (subjectKind, subjectId, actorId) — no sessionId is required.
   * The session-independence is structural: upsertClaim accepts sessionId as optional.
   */
  test("upsertClaim succeeds with no sessionId (session-independent write)", async () => {
    const db = createSmartFakeDb();

    const repo = new DrizzlePresenceClaimRepository(db as unknown as PostgresJsDatabase);

    // No sessionId in the input — this is the session-independent case
    const input: UpsertPresenceClaimInput = {
      subjectKind: "task",
      subjectId: "mt#2562",
      actorId: "claude-code:claude-sonnet-4-without-session",
      ccConversationId: "conv-xyz",
      // sessionId intentionally absent
    };

    const claim = await repo.upsertClaim(input);

    expect(claim.subjectId).toBe("mt#2562");
    expect(claim.actorId).toBe("claude-code:claude-sonnet-4-without-session");
    expect(claim.sessionId).toBeUndefined(); // No session — that's the point
    expect(claim.ccConversationId).toBe("conv-xyz");
    expect(db.__rows()).toHaveLength(1);
  });

  test("upsertClaim succeeds with partial where-context (fire-and-forget posture)", async () => {
    const db = createSmartFakeDb();

    const repo = new DrizzlePresenceClaimRepository(db as unknown as PostgresJsDatabase);

    // Minimal input — only required fields
    const claim = await repo.upsertClaim({
      subjectKind: "task",
      subjectId: "mt#2562",
      actorId: "bare-actor-no-context",
    });

    expect(claim.subjectId).toBe("mt#2562");
    expect(claim.sessionId).toBeUndefined();
    expect(claim.ccConversationId).toBeUndefined();
    expect(claim.tty).toBeUndefined();
    expect(claim.host).toBeUndefined();
  });
});
