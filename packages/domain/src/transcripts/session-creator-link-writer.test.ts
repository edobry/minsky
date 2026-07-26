/**
 * Tests for session-creator-link-writer (mt#3120 — `minsky_session_links`
 * `session_creator` writer + `agent_transcripts` stub upsert).
 *
 * Uses in-memory fakes for the DB — no real Postgres access (mirrors
 * driven-link-writer.test.ts's two-table fake convention).
 *
 * @see ./session-creator-link-writer.ts
 * @see mt#3120
 */

import { describe, test, expect } from "bun:test";

import {
  writeSessionCreatorLink,
  SESSION_CREATOR_LINK_TYPE,
  SESSION_CREATOR_CONFIDENCE,
} from "./session-creator-link-writer";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import type { ConversationId } from "../ids";

const CONVERSATION_ID = "cccccccc-0000-0000-0000-000000000003" as ConversationId;
const WORKSPACE_SESSION_ID = "dddddddd-0000-0000-0000-000000000004";
const CWD = "/Users/edobry/Projects/minsky";

interface FakeStubRow {
  agentSessionId: string;
  harness: string;
  cwd: string;
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
  conversationId: CONVERSATION_ID,
  workspaceSessionId: WORKSPACE_SESSION_ID,
  cwd: CWD,
};

describe("writeSessionCreatorLink", () => {
  test("writes the stub transcript row and the session_creator link row", async () => {
    const stores = makeStores();
    const outcome = await writeSessionCreatorLink(asPg(makeDb(stores)), INPUT);

    expect(outcome).toBe("written");

    const stub = stores.stubs.get(CONVERSATION_ID);
    expect(stub).toBeDefined();
    expect(stub?.harness).toBe("claude_code");
    expect(stub?.cwd).toBe(CWD);

    const link = stores.links.get(`${CONVERSATION_ID}:${WORKSPACE_SESSION_ID}`);
    expect(link).toBeDefined();
    expect(link?.linkType).toBe(SESSION_CREATOR_LINK_TYPE);
    expect(link?.confidence).toBe(SESSION_CREATOR_CONFIDENCE);
  });

  test("inserts the stub row BEFORE the link row (FK ordering)", async () => {
    const stores = makeStores();
    await writeSessionCreatorLink(asPg(makeDb(stores)), INPUT);
    expect(stores.insertOrder).toEqual(["agent_transcripts", "minsky_session_links"]);
  });

  test("is idempotent — a second call leaves exactly one row in each store", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));
    expect(await writeSessionCreatorLink(db, INPUT)).toBe("written");
    expect(await writeSessionCreatorLink(db, INPUT)).toBe("written");
    expect(stores.stubs.size).toBe(1);
    expect(stores.links.size).toBe(1);
  });

  test("returns 'error' (never throws) when the stub insert fails", async () => {
    const stores = makeStores();
    const outcome = await writeSessionCreatorLink(
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
    const outcome = await writeSessionCreatorLink(
      asPg(makeDb(stores, { throwOnLinkInsert: true })),
      INPUT
    );
    expect(outcome).toBe("error");
    // The stub upsert already landed — harmless (it is exactly what a later
    // full ingest would have inserted) and idempotent on retry.
    expect(stores.stubs.size).toBe(1);
  });
});
