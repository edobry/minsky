/**
 * Tests for the entity discussion thread store (mt#3364).
 *
 * The pure functions carry this module's load-bearing invariants — deterministic
 * identity, id namespacing, and the render projection — so they are tested
 * directly with no DB involved. The two DB-touching functions are tested against
 * a trivial `db.execute` fake, matching the sibling
 * ./driven-session-registry-store.test.ts convention.
 */

import { describe, expect, test } from "bun:test";

import {
  ENTITY_THREAD_ID_PREFIX,
  appendEntityThreadTurn,
  entityThreadLocalId,
  entityThreadTurnId,
  listEntityThreadBlocks,
  listEntityThreadTurns,
  mapRawEntityThreadTurnRow,
  turnToSnapshotBlock,
  type EntityThreadTurn,
  type RawEntityThreadTurnRow,
} from "./entity-thread-store";

/** The thread under test throughout — derived, not hand-written, so these
 * tests break if the derivation format ever changes silently. */
const THREAD_ID = entityThreadLocalId("ask", "abc");
const TURN_1_ID = entityThreadTurnId(THREAD_ID, 1);
const TURN_2_ID = entityThreadTurnId(THREAD_ID, 2);
const TURN_3_ID = entityThreadTurnId(THREAD_ID, 3);
const CREATED_AT = new Date("2026-07-30T18:00:00Z");

describe("entityThreadLocalId", () => {
  test("is deterministic — the same entity always yields the same id", () => {
    const first = entityThreadLocalId("ask", "38b1c0de-1234-4000-8000-000000000000");
    const second = entityThreadLocalId("ask", "38b1c0de-1234-4000-8000-000000000000");
    expect(first).toBe(second);
  });

  test("percent-encodes the '#' in a task id so the id stays a single safe token", () => {
    const id = entityThreadLocalId("task", "mt#3364");
    expect(id).toBe("entity-thread:task:mt%233364");
    expect(id).not.toContain("#");
  });

  test("distinguishes entities that share an id across different types", () => {
    expect(entityThreadLocalId("task", "123")).not.toBe(entityThreadLocalId("changeset", "123"));
  });

  test("is prefixed so it cannot collide with a session-derived snapshot block id", () => {
    // Snapshot block ids are "synthesized from session id + position"; a session
    // id is a bare uuid, so a prefixed id is disjoint from that space by
    // construction. This is the invariant ConversationView's extraBlocks seam
    // depends on ("Block ids in extraBlocks must NOT collide with snapshot
    // block ids").
    const id = entityThreadLocalId("ask", "2154425b-0000-4000-8000-000000000000");
    expect(id.startsWith(`${ENTITY_THREAD_ID_PREFIX}:`)).toBe(true);
    expect(/^[0-9a-f-]{36}/.test(id)).toBe(false);
  });
});

describe("entityThreadTurnId", () => {
  test("inherits the thread's namespace, so turn ids are disjoint from snapshot ids too", () => {
    expect(TURN_1_ID.startsWith(`${ENTITY_THREAD_ID_PREFIX}:`)).toBe(true);
  });

  test("is unique per sequence position within a thread", () => {
    expect(TURN_1_ID).not.toBe(TURN_2_ID);
  });

  test("matches the id the SQL insert builds (localId || '#' || seq)", () => {
    // appendEntityThreadTurn computes the id in SQL rather than in JS so the
    // seq allocation stays atomic; this pins the two derivations to the same
    // format so a stored id is always reproducible from (localId, seq).
    expect(entityThreadTurnId(THREAD_ID, 7)).toBe(`${THREAD_ID}#7`);
  });
});

describe("turnToSnapshotBlock", () => {
  const baseTurn: EntityThreadTurn = {
    id: TURN_1_ID,
    localId: THREAD_ID,
    seq: 1,
    role: "operator",
    content: "what is this ask actually asking me to authorize?",
    createdAt: CREATED_AT,
  };

  test("projects an operator turn to the existing user-prompt block type", () => {
    const block = turnToSnapshotBlock(baseTurn);
    expect(block.type).toBe("user-prompt");
    expect(block.content).toBe(baseTurn.content);
    expect(block.id).toBe(baseTurn.id);
  });

  test("projects an agent turn to the existing assistant-text block type", () => {
    const block = turnToSnapshotBlock({ ...baseTurn, role: "agent", content: "it needs..." });
    expect(block.type).toBe("assistant-text");
  });

  test("always marks the block observed — a thread turn actually happened", () => {
    expect(turnToSnapshotBlock(baseTurn).source).toBe("observed");
    expect(turnToSnapshotBlock({ ...baseTurn, role: "agent" }).source).toBe("observed");
  });

  test("supplies the block type's two other required fields", () => {
    // SessionContextSnapshotBlock requires `timestamp` and `rawJsonlType`; a
    // projection missing either does not satisfy the render contract, so the
    // "no adapter shim" claim depends on both being populated here.
    const block = turnToSnapshotBlock(baseTurn);
    expect(block.timestamp).toBe(CREATED_AT.toISOString());
    expect(block.rawJsonlType).toBe("user");
    expect(turnToSnapshotBlock({ ...baseTurn, role: "agent" }).rawJsonlType).toBe("assistant");
  });
});

describe("mapRawEntityThreadTurnRow", () => {
  const raw: RawEntityThreadTurnRow = {
    id: TURN_1_ID,
    local_id: THREAD_ID,
    seq: 1,
    role: "operator",
    content: "hello",
    created_at: CREATED_AT,
  };

  test("coerces a string seq to a number (postgres-js may return integers as strings)", () => {
    const mapped = mapRawEntityThreadTurnRow({ ...raw, seq: "42" });
    expect(mapped.seq).toBe(42);
    expect(typeof mapped.seq).toBe("number");
  });

  test("parses a string created_at into a Date", () => {
    const mapped = mapRawEntityThreadTurnRow({ ...raw, created_at: "2026-07-30T18:00:00Z" });
    expect(mapped.createdAt instanceof Date).toBe(true);
    expect(mapped.createdAt.toISOString()).toBe("2026-07-30T18:00:00.000Z");
  });

  test("maps the agent role through, and falls back to operator for anything unrecognized", () => {
    expect(mapRawEntityThreadTurnRow({ ...raw, role: "agent" }).role).toBe("agent");
    // A row written by some future code path with an unknown role must not
    // render as an agent message — attributing operator text to the agent (or
    // vice versa) is worse than a conservative default.
    expect(mapRawEntityThreadTurnRow({ ...raw, role: "wat" }).role).toBe("operator");
  });
});

/** Minimal `db.execute` fake — the only surface these functions touch. */
function fakeDb(rows: unknown[]): { execute: (q: unknown) => Promise<unknown> } {
  return { execute: async () => rows };
}

describe("appendEntityThreadTurn", () => {
  test("returns the turn the database assigned, not one predicted by the caller", async () => {
    // The DB allocates seq atomically inside the INSERT, so the caller must
    // read it back rather than guess — this pins that contract.
    const db = fakeDb([
      {
        id: TURN_3_ID,
        local_id: THREAD_ID,
        seq: 3,
        role: "agent",
        content: "because that session needed it",
        created_at: CREATED_AT,
      },
    ]);
    const turn = await appendEntityThreadTurn(db as never, {
      localId: THREAD_ID,
      role: "agent",
      content: "because that session needed it",
    });
    expect(turn.seq).toBe(3);
    expect(turn.id).toBe(TURN_3_ID);
  });

  test("throws rather than fabricating a turn when the insert returns no row", async () => {
    await expect(
      appendEntityThreadTurn(fakeDb([]) as never, {
        localId: THREAD_ID,
        role: "operator",
        content: "hi",
      })
    ).rejects.toThrow(/returned no row/);
  });
});

describe("listEntityThreadTurns / listEntityThreadBlocks", () => {
  const rows: RawEntityThreadTurnRow[] = [
    {
      id: TURN_1_ID,
      local_id: THREAD_ID,
      seq: 1,
      role: "operator",
      content: "what is this?",
      created_at: CREATED_AT,
    },
    {
      id: TURN_2_ID,
      local_id: THREAD_ID,
      seq: 2,
      role: "agent",
      content: "it is an authorization request",
      created_at: CREATED_AT,
    },
  ];

  test("maps every row through the shared mapper", async () => {
    const turns = await listEntityThreadTurns(fakeDb(rows) as never, THREAD_ID);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("operator");
    expect(turns[1]?.role).toBe("agent");
  });

  test("blocks come back ready for ConversationView's extraBlocks seam", async () => {
    const blocks = await listEntityThreadBlocks(fakeDb(rows) as never, THREAD_ID);
    expect(blocks.map((b) => b.type)).toEqual(["user-prompt", "assistant-text"]);
    expect(blocks.every((b) => b.source === "observed")).toBe(true);
    // Ids must be distinct — a duplicate id inside extraBlocks would collapse
    // two turns into one rendered element.
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  test("an empty thread yields no blocks rather than throwing", async () => {
    expect(await listEntityThreadBlocks(fakeDb([]) as never, THREAD_ID)).toEqual([]);
  });
});
