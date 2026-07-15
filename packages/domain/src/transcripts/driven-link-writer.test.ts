/**
 * Tests for driven-link-writer (mt#2752 — `minsky_session_links`
 * `driven_spawn` writer + `agent_transcripts` stub upsert).
 *
 * Uses in-memory fakes for the DB — no real Postgres access (mirrors
 * spawn-link-writer.test.ts's fake convention, extended to route inserts by
 * table identity since this writer touches TWO tables in FK order).
 *
 * @see ./driven-link-writer.ts
 * @see mt#2752
 */

import { describe, test, expect } from "bun:test";

import {
  writeDrivenSpawnLink,
  DRIVEN_SPAWN_LINK_TYPE,
  DRIVEN_SPAWN_CONFIDENCE,
  DRIVEN_STUB_HARNESS,
} from "./driven-link-writer";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";

const HARNESS_SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const WORKSPACE_SESSION = "bbbbbbbb-0000-0000-0000-000000000002";
const CWD = "/state/minsky/sessions/bbbbbbbb-0000-0000-0000-000000000002";
const STARTED_AT = "2026-07-15T12:00:00.000Z";

interface FakeStubRow {
  agentSessionId: string;
  harness: string;
  cwd: string;
  startedAt: Date;
}

interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

interface FakeStores {
  stubs: Map<string, FakeStubRow>;
  links: Map<string, FakeLinkRow>;
  insertOrder: string[];
}

function makeStores(): FakeStores {
  return { stubs: new Map(), links: new Map(), insertOrder: [] };
}

/**
 * Two-table fake: routes each insert by the TABLE OBJECT IDENTITY the writer
 * passes, so the test verifies the writer targets the real imported schema
 * objects (not just "some insert happened") AND records FK-relevant ordering.
 */
function makeDb(
  stores: FakeStores,
  opts?: { throwOnStubInsert?: boolean; throwOnLinkInsert?: boolean }
) {
  return {
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          return {
            onConflictDoNothing(): Promise<void> {
              if (table === agentTranscriptsTable) {
                if (opts?.throwOnStubInsert) {
                  return Promise.reject(new Error("simulated stub-insert error"));
                }
                stores.insertOrder.push("agent_transcripts");
                const row = v as unknown as FakeStubRow;
                if (!stores.stubs.has(row.agentSessionId)) {
                  stores.stubs.set(row.agentSessionId, { ...row });
                }
                return Promise.resolve();
              }
              if (table === minskySessionLinksTable) {
                if (opts?.throwOnLinkInsert) {
                  return Promise.reject(new Error("simulated link-insert error"));
                }
                stores.insertOrder.push("minsky_session_links");
                const row = v as unknown as FakeLinkRow;
                const key = `${row.agentSessionId}:${row.minskySessionId}`;
                if (!stores.links.has(key)) stores.links.set(key, { ...row });
                return Promise.resolve();
              }
              return Promise.reject(new Error("insert against an unexpected table"));
            },
          };
        },
      };
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

const INPUT = {
  agentSessionId: HARNESS_SESSION,
  minskySessionId: WORKSPACE_SESSION,
  cwd: CWD,
  startedAt: STARTED_AT,
};

describe("writeDrivenSpawnLink", () => {
  test("writes the stub transcript row and the driven_spawn link row", async () => {
    const stores = makeStores();
    const outcome = await writeDrivenSpawnLink(asPg(makeDb(stores)), INPUT);

    expect(outcome).toBe("written");

    const stub = stores.stubs.get(HARNESS_SESSION);
    expect(stub).toBeDefined();
    expect(stub?.harness).toBe(DRIVEN_STUB_HARNESS);
    expect(stub?.cwd).toBe(CWD);
    expect(stub?.startedAt).toEqual(new Date(STARTED_AT));

    const link = stores.links.get(`${HARNESS_SESSION}:${WORKSPACE_SESSION}`);
    expect(link).toBeDefined();
    expect(link?.linkType).toBe(DRIVEN_SPAWN_LINK_TYPE);
    expect(link?.confidence).toBe(DRIVEN_SPAWN_CONFIDENCE);
  });

  test("inserts the stub row BEFORE the link row (FK ordering)", async () => {
    const stores = makeStores();
    await writeDrivenSpawnLink(asPg(makeDb(stores)), INPUT);
    expect(stores.insertOrder).toEqual(["agent_transcripts", "minsky_session_links"]);
  });

  test("is idempotent — a second call leaves exactly one row in each store", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));
    expect(await writeDrivenSpawnLink(db, INPUT)).toBe("written");
    expect(await writeDrivenSpawnLink(db, INPUT)).toBe("written");
    expect(stores.stubs.size).toBe(1);
    expect(stores.links.size).toBe(1);
  });

  test("returns 'error' (never throws) when the stub insert fails", async () => {
    const stores = makeStores();
    const outcome = await writeDrivenSpawnLink(
      asPg(makeDb(stores, { throwOnStubInsert: true })),
      INPUT
    );
    expect(outcome).toBe("error");
    // The link insert must not have run — FK ordering means a failed stub
    // write short-circuits before the dependent link write.
    expect(stores.links.size).toBe(0);
  });

  test("returns 'error' (never throws) when the link insert fails", async () => {
    const stores = makeStores();
    const outcome = await writeDrivenSpawnLink(
      asPg(makeDb(stores, { throwOnLinkInsert: true })),
      INPUT
    );
    expect(outcome).toBe("error");
    // The stub upsert already landed — harmless (it is exactly what a later
    // full ingest would have inserted) and idempotent on retry.
    expect(stores.stubs.size).toBe(1);
  });
});
