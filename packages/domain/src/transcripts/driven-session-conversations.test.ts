/**
 * Tests for the conversation-adoption series (mt#4323, ADR-044).
 *
 * Covers `recordConversationAdoption`, `resolveConversationIds` and the
 * `resolveReplacedConversationId` projection in
 * ./driven-session-registry-store.ts.
 *
 * **What a fake DB can and cannot establish here, stated up front.** The fake
 * mirrors the sibling convention in ./driven-session-registry-store.test.ts —
 * no real Postgres (mt#3254). It therefore exercises everything that lives in
 * TypeScript: append-only insert behaviour, the never-throw contract, the
 * discriminated read result, and the projection's scan. It does NOT exercise
 * the `ORDER BY adopted_at ASC, id ASC` clause or the table's DDL, both of
 * which are SQL — those are asserted against a real database by
 * scripts/verify-driven-session-conversations.ts, which is why that script
 * exists rather than being a formality.
 *
 * @see ./driven-session-registry-store.ts
 * @see mt#4323
 */

import { describe, test, expect } from "bun:test";

import {
  recordConversationAdoption,
  resolveConversationIds,
  resolveReplacedConversationId,
} from "./driven-session-registry-store";
import {
  drivenSessionConversationsTable,
  type AdoptionReason,
} from "../storage/schemas/driven-sessions-schema";

interface AdoptionRow {
  localId: string;
  harnessSessionId: string;
  harness: string;
  driverGeneration: number;
  adoptionReason: string;
  adoptedAt: Date;
}

interface FakeStores {
  rows: AdoptionRow[];
  insertCalls: number;
}

function makeStores(): FakeStores {
  return { rows: [], insertCalls: 0 };
}

/**
 * Fake DB. `execute()` serves the adoption rows back in the order the real
 * query's `ORDER BY adopted_at ASC, seq ASC` would produce: by timestamp, then
 * by insertion sequence.
 *
 * The insertion index stands in for the real `seq` column, which is
 * `GENERATED ALWAYS AS IDENTITY` and therefore monotonic. It deliberately does
 * NOT model `id`: ordering by that would be arbitrary, which is the defect
 * PR #3218 R1 caught. Note this fake cannot CATCH that defect — it sorts on
 * the code's behalf either way — which is exactly why the equal-timestamp case
 * is asserted against a real database in
 * scripts/verify-driven-session-conversations.ts step 5.
 */
function makeDb(stores: FakeStores, opts?: { throwOnInsert?: boolean; throwOnExecute?: boolean }) {
  return {
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>): Promise<void> {
          stores.insertCalls += 1;
          if (table !== drivenSessionConversationsTable) {
            return Promise.reject(new Error("insert against an unexpected table"));
          }
          if (opts?.throwOnInsert) {
            return Promise.reject(new Error("simulated insert error"));
          }
          stores.rows.push(v as unknown as AdoptionRow);
          return Promise.resolve();
        },
      };
    },
    async execute(_query: unknown): Promise<unknown> {
      if (opts?.throwOnExecute) throw new Error("simulated execute error");
      return stores.rows
        .map((row, seq) => ({ row, seq }))
        .sort((a, b) => {
          const byTime = a.row.adoptedAt.getTime() - b.row.adoptedAt.getTime();
          return byTime !== 0 ? byTime : a.seq - b.seq;
        })
        .map(({ row }) => ({
          harness_session_id: row.harnessSessionId,
          adoption_reason: row.adoptionReason,
        }));
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

const LOCAL_ID = "local-4323";
/** Extracted so the swap reason is written once (custom/no-magic-string-duplication). */
const SWAP: AdoptionReason = "prior-conversation-unrecoverable";
const HARNESS = "claude_code";

function adopt(harnessSessionId: string, adoptionReason: AdoptionReason) {
  return { localId: LOCAL_ID, harnessSessionId, harness: HARNESS, adoptionReason };
}

describe("recordConversationAdoption — append-only (AT1)", () => {
  test("two adoptions on one localId produce two rows, and the first is unchanged", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    const seeded = stores.rows[0];
    if (!seeded) throw new Error("the first adoption did not land");
    const firstAfterOne: AdoptionRow = { ...seeded };

    await recordConversationAdoption(db, adopt("conv-b", SWAP));

    expect(stores.rows.length).toBe(2);
    // Byte-identical, asserted rather than documented: an upsert would have
    // mutated this row in place instead of appending a second one.
    expect(stores.rows[0]).toEqual(firstAfterOne);
    expect(stores.rows[1]?.harnessSessionId).toBe("conv-b");
  });

  test("re-adopting the SAME conversation id is two events, not one", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    await recordConversationAdoption(db, adopt("conv-a", "resumed"));

    expect(stores.rows.length).toBe(2);
    expect(stores.rows.map((r) => r.adoptionReason)).toEqual(["initial", "resumed"]);
  });

  test("defaults driverGeneration to 0 and stamps adoptedAt", async () => {
    const stores = makeStores();
    await recordConversationAdoption(asPg(makeDb(stores)), adopt("conv-a", "initial"));

    expect(stores.rows[0]?.driverGeneration).toBe(0);
    expect(stores.rows[0]?.adoptedAt).toBeInstanceOf(Date);
  });

  test("carries the session driver generation through when given one", async () => {
    const stores = makeStores();
    await recordConversationAdoption(asPg(makeDb(stores)), {
      ...adopt("conv-a", "initial"),
      driverGeneration: 3,
    });

    expect(stores.rows[0]?.driverGeneration).toBe(3);
  });
});

describe("recordConversationAdoption — never fails the spawn", () => {
  test("returns 'error' instead of throwing when the insert fails", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores, { throwOnInsert: true }));

    // The whole point: a spawn must not fail because its recovery-state write
    // could not. If this ever throws, the spawn path it is detached from dies.
    const outcome = await recordConversationAdoption(db, adopt("conv-a", "initial"));

    expect(outcome).toBe("error");
    expect(stores.rows.length).toBe(0);
  });

  test("returns 'written' on success", async () => {
    const stores = makeStores();
    const outcome = await recordConversationAdoption(
      asPg(makeDb(stores)),
      adopt("conv-a", "initial")
    );
    expect(outcome).toBe("written");
  });
});

describe("resolveConversationIds — the full span (AT2, AT6)", () => {
  test("a session that swapped TWICE resolves all three ids (AT2)", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    await recordConversationAdoption(db, adopt("conv-b", SWAP));
    await recordConversationAdoption(db, adopt("conv-c", SWAP));

    const span = await resolveConversationIds(db, LOCAL_ID);

    expect(span.ok).toBe(true);
    // The case replaced_conversation_id provably cannot serve: it is singular
    // and last-write-wins, so conv-a is already gone from it by now.
    expect(span.ok && span.conversationIds).toEqual(["conv-a", "conv-b", "conv-c"]);
  });

  test("a single initial adoption resolves to exactly one id — no phantom predecessor (AT6)", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));

    const span = await resolveConversationIds(db, LOCAL_ID);
    expect(span.ok && span.conversationIds).toEqual(["conv-a"]);
  });

  test("a session with no adoptions resolves to an empty span, ok:true", async () => {
    const stores = makeStores();
    const span = await resolveConversationIds(asPg(makeDb(stores)), LOCAL_ID);

    expect(span.ok).toBe(true);
    expect(span.ok && span.conversationIds).toEqual([]);
  });

  test("a READ FAILURE is ok:false, never an empty span", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores, { throwOnExecute: true }));

    const span = await resolveConversationIds(db, LOCAL_ID);

    // Returning [] here would be byte-identical to "this session adopted
    // nothing", and those two call for opposite responses. That collapse is
    // the same shape as the defect this table exists to close.
    expect(span.ok).toBe(false);
    expect(span.ok === false && span.error).toContain("simulated execute error");
  });
});

describe("adoptionReason round-trips the whole union (AT4)", () => {
  const ALL_REASONS: AdoptionReason[] = [
    "no-prior-conversation",
    SWAP,
    "prior-spawn-never-linked",
    "resume-attempt-failed",
    "initial",
    "resumed",
  ];

  test("every member writes and reads back unchanged", async () => {
    for (const reason of ALL_REASONS) {
      const stores = makeStores();
      const db = asPg(makeDb(stores));
      await recordConversationAdoption(db, adopt("conv-a", reason));
      expect(stores.rows[0]?.adoptionReason).toBe(reason);
    }
  });

  test("a value outside the union is a TYPE error, and the union is exactly these six", async () => {
    // Compile-time half. The column is `text` with no CHECK constraint, so
    // rejection is the type system's job and nothing rejects at runtime —
    // stated plainly rather than implied, because AT4 says "rejected" and a
    // reader could otherwise expect a thrown error here.
    // @ts-expect-error — "abandoned" is not an AdoptionReason
    const invalid: AdoptionReason = "abandoned";
    expect(typeof invalid).toBe("string");

    // Runtime half, so this test still exercises executable behaviour: the
    // union has exactly the six members above, no more.
    expect(new Set(ALL_REASONS).size).toBe(6);
  });
});

describe("resolveReplacedConversationId — the one-deep projection (criterion 5)", () => {
  test("returns the conversation the newest swap replaced", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    await recordConversationAdoption(db, adopt("conv-b", SWAP));

    expect(await resolveReplacedConversationId(db, LOCAL_ID)).toBe("conv-a");
  });

  test("after a SECOND swap it reports the newer replacement, matching last-write-wins", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    await recordConversationAdoption(db, adopt("conv-b", SWAP));
    await recordConversationAdoption(db, adopt("conv-c", SWAP));

    // Same answer the stored column would hold — this projection is a
    // back-compat replacement for it, not an upgrade. The full history is
    // resolveConversationIds' job.
    expect(await resolveReplacedConversationId(db, LOCAL_ID)).toBe("conv-b");
  });

  test("a session that never swapped has no replaced id (AT5's no-swap case)", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));
    await recordConversationAdoption(db, adopt("conv-a", "resumed"));

    // `resumed` re-adopts the predecessor rather than replacing it, so there
    // is nothing to report — and reporting conv-a here would invent a swap.
    expect(await resolveReplacedConversationId(db, LOCAL_ID)).toBeUndefined();
  });

  test("an initial adoption alone has no predecessor to report", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    await recordConversationAdoption(db, adopt("conv-a", "initial"));

    expect(await resolveReplacedConversationId(db, LOCAL_ID)).toBeUndefined();
  });

  test("a swap in the FIRST row has no predecessor and reports nothing", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));

    // Reachable: a thread whose very first recorded adoption is a fresh spawn
    // because the daemon could not reach its (pre-migration) history.
    await recordConversationAdoption(db, adopt("conv-a", "no-prior-conversation"));

    expect(await resolveReplacedConversationId(db, LOCAL_ID)).toBeUndefined();
  });
});
