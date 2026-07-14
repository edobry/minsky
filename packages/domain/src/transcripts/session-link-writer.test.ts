/**
 * Tests for session-link-writer (mt#2441 — `minsky_session_links` `cwd_match`
 * writer + idempotent backfill).
 *
 * Uses in-memory fakes for the DB — no real Postgres access.
 *
 * @see ./session-link-writer.ts
 * @see mt#2441
 */

import { describe, test, expect } from "bun:test";

import {
  detectCwdMatch,
  writeCwdMatchLink,
  backfillCwdMatchLinks,
  CWD_MATCH_LINK_TYPE,
  CWD_MATCH_EXACT_CONFIDENCE,
  CWD_MATCH_DESCENDANT_CONFIDENCE,
} from "./session-link-writer";

const SESSIONS_DIR = "/state/minsky/sessions";
const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";

// ── detectCwdMatch (pure) ────────────────────────────────────────────────────

describe("detectCwdMatch", () => {
  test("returns null for a null/undefined cwd", () => {
    expect(detectCwdMatch(null, SESSIONS_DIR)).toBeNull();
    expect(detectCwdMatch(undefined, SESSIONS_DIR)).toBeNull();
  });

  test("returns null for an empty string cwd", () => {
    expect(detectCwdMatch("", SESSIONS_DIR)).toBeNull();
  });

  test("exact match: cwd === <sessionsDir>/<id> -> confidence 1.0", () => {
    const result = detectCwdMatch(`${SESSIONS_DIR}/${SESSION_A}`, SESSIONS_DIR);
    expect(result).toEqual({
      minskySessionId: SESSION_A,
      confidence: CWD_MATCH_EXACT_CONFIDENCE,
    });
  });

  test("descendant match: cwd nested under <sessionsDir>/<id>/... -> confidence 0.8", () => {
    const result = detectCwdMatch(`${SESSIONS_DIR}/${SESSION_A}/src/domain/foo.ts`, SESSIONS_DIR);
    expect(result).toEqual({
      minskySessionId: SESSION_A,
      confidence: CWD_MATCH_DESCENDANT_CONFIDENCE,
    });
  });

  test("deeply nested descendant still resolves to the top-level session id", () => {
    const result = detectCwdMatch(
      `${SESSIONS_DIR}/${SESSION_A}/packages/domain/src/transcripts`,
      SESSIONS_DIR
    );
    expect(result?.minskySessionId).toBe(SESSION_A);
    expect(result?.confidence).toBe(CWD_MATCH_DESCENDANT_CONFIDENCE);
  });

  test("returns null when cwd is entirely unrelated to the sessions dir", () => {
    expect(detectCwdMatch("/Users/someone/Projects/other-repo", SESSIONS_DIR)).toBeNull();
  });

  test("returns null when cwd equals the sessions dir itself (no session-id segment)", () => {
    expect(detectCwdMatch(SESSIONS_DIR, SESSIONS_DIR)).toBeNull();
  });

  test("does not false-positive-match a sibling directory sharing the sessions-dir prefix", () => {
    // e.g. "/state/minsky/sessions-archive/<id>" must NOT match
    // "/state/minsky/sessions" as a prefix.
    expect(detectCwdMatch(`${SESSIONS_DIR}-archive/${SESSION_A}`, SESSIONS_DIR)).toBeNull();
  });

  test("normalizes a sessionsDir passed with a trailing slash", () => {
    const result = detectCwdMatch(`${SESSIONS_DIR}/${SESSION_A}`, `${SESSIONS_DIR}/`);
    expect(result).toEqual({
      minskySessionId: SESSION_A,
      confidence: CWD_MATCH_EXACT_CONFIDENCE,
    });
  });

  test("uses the live getSessionsDir() when sessionsDir is not passed", () => {
    // Default param resolves via @minsky/shared/paths — just confirm it
    // doesn't throw and returns null for a cwd that certainly won't match
    // whatever this environment's sessions dir happens to be.
    expect(detectCwdMatch("/definitely/not/a/session/workspace")).toBeNull();
  });
});

// ── writeCwdMatchLink (DB-backed, in-memory fake) ───────────────────────────

interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

function makeLinkDb(store: Map<string, FakeLinkRow>, opts?: { throwOnInsert?: boolean }) {
  return {
    insert(_table: unknown) {
      return {
        values(v: FakeLinkRow) {
          return {
            onConflictDoNothing(): Promise<void> {
              if (opts?.throwOnInsert) {
                return Promise.reject(new Error("simulated DB error"));
              }
              const key = `${v.agentSessionId}:${v.minskySessionId}`;
              if (!store.has(key)) store.set(key, { ...v });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

type FakeLinkDb = ReturnType<typeof makeLinkDb>;
function asPg(db: FakeLinkDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

describe("writeCwdMatchLink", () => {
  test("writes a link row for a matching cwd and returns true", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);

    const written = await writeCwdMatchLink(
      asPg(db),
      SESSION_A,
      `${SESSIONS_DIR}/${SESSION_B}`,
      SESSIONS_DIR
    );

    expect(written).toBe(true);
    const row = store.get(`${SESSION_A}:${SESSION_B}`);
    expect(row).toEqual({
      agentSessionId: SESSION_A,
      minskySessionId: SESSION_B,
      linkType: CWD_MATCH_LINK_TYPE,
      confidence: CWD_MATCH_EXACT_CONFIDENCE,
    });
  });

  test("no-ops (no DB call) and returns false when cwd does not match", async () => {
    const store = new Map<string, FakeLinkRow>();
    let insertCalled = false;
    const db = {
      insert(_table: unknown) {
        insertCalled = true;
        return { values: () => ({ onConflictDoNothing: () => Promise.resolve() }) };
      },
    };

    const written = await writeCwdMatchLink(
      asPg(db as unknown as FakeLinkDb),
      SESSION_A,
      "/unrelated/path",
      SESSIONS_DIR
    );

    expect(written).toBe(false);
    expect(insertCalled).toBe(false);
    expect(store.size).toBe(0);
  });

  test("no-ops and returns false when cwd is null", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);

    const written = await writeCwdMatchLink(asPg(db), SESSION_A, null, SESSIONS_DIR);

    expect(written).toBe(false);
    expect(store.size).toBe(0);
  });

  test("swallows a DB failure and returns false rather than throwing", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store, { throwOnInsert: true });

    const written = await writeCwdMatchLink(
      asPg(db),
      SESSION_A,
      `${SESSIONS_DIR}/${SESSION_B}`,
      SESSIONS_DIR
    );

    expect(written).toBe(false);
    expect(store.size).toBe(0);
  });

  test("idempotent: writing the same link twice does not duplicate or error", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);
    const cwd = `${SESSIONS_DIR}/${SESSION_B}`;

    await writeCwdMatchLink(asPg(db), SESSION_A, cwd, SESSIONS_DIR);
    const after1 = store.size;
    const written2 = await writeCwdMatchLink(asPg(db), SESSION_A, cwd, SESSIONS_DIR);

    expect(written2).toBe(true);
    expect(store.size).toBe(after1);
  });
});

// ── backfillCwdMatchLinks (DB-backed, in-memory fake) ───────────────────────

interface FakeTranscriptRow {
  agentSessionId: string;
  cwd: string | null;
}

function makeBackfillDb(
  transcriptRows: FakeTranscriptRow[],
  linkStore: Map<string, FakeLinkRow>,
  opts?: { throwOnSelect?: boolean; failLinkForSessionId?: string }
) {
  return {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown): Promise<FakeTranscriptRow[]> => {
          if (opts?.throwOnSelect) {
            return Promise.reject(new Error("simulated select failure"));
          }
          return Promise.resolve(transcriptRows);
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(v: FakeLinkRow) {
          return {
            onConflictDoNothing(): Promise<void> {
              if (opts?.failLinkForSessionId === v.agentSessionId) {
                return Promise.reject(new Error("simulated link-insert failure"));
              }
              const key = `${v.agentSessionId}:${v.minskySessionId}`;
              if (!linkStore.has(key)) linkStore.set(key, { ...v });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

type FakeBackfillDb = ReturnType<typeof makeBackfillDb>;
function asBackfillPg(db: FakeBackfillDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

describe("backfillCwdMatchLinks", () => {
  test("writes links for matching rows and skips non-matching ones", async () => {
    const rows: FakeTranscriptRow[] = [
      { agentSessionId: "agent-1", cwd: `${SESSIONS_DIR}/${SESSION_A}` },
      { agentSessionId: "agent-2", cwd: `${SESSIONS_DIR}/${SESSION_B}/nested` },
      { agentSessionId: "agent-3", cwd: "/unrelated/project" },
      { agentSessionId: "agent-4", cwd: null },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore);

    const result = await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.transcriptsScanned).toBe(4);
    expect(result.linksWritten).toBe(2);
    expect(result.linksSkippedNoMatch).toBe(2);
    expect(result.linksErrored).toBe(0);
    expect(linkStore.get(`agent-1:${SESSION_A}`)?.confidence).toBe(CWD_MATCH_EXACT_CONFIDENCE);
    expect(linkStore.get(`agent-2:${SESSION_B}`)?.confidence).toBe(CWD_MATCH_DESCENDANT_CONFIDENCE);
  });

  test("counts a per-row write failure as errored without aborting the sweep", async () => {
    const rows: FakeTranscriptRow[] = [
      { agentSessionId: "agent-1", cwd: `${SESSIONS_DIR}/${SESSION_A}` },
      { agentSessionId: "agent-2", cwd: `${SESSIONS_DIR}/${SESSION_B}` },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore, { failLinkForSessionId: "agent-1" });

    const result = await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.transcriptsScanned).toBe(2);
    expect(result.linksWritten).toBe(1);
    expect(result.linksErrored).toBe(1);
    expect(linkStore.has(`agent-2:${SESSION_B}`)).toBe(true);
    expect(linkStore.has(`agent-1:${SESSION_A}`)).toBe(false);
  });

  test("returns zero-value result (no throw) when the transcript load fails", async () => {
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb([], linkStore, { throwOnSelect: true });

    const result = await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result).toEqual({
      transcriptsScanned: 0,
      linksWritten: 0,
      linksSkippedNoMatch: 0,
      linksErrored: 0,
    });
  });

  test("empty corpus -> zero counts", async () => {
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb([], linkStore);

    const result = await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.transcriptsScanned).toBe(0);
    expect(result.linksWritten).toBe(0);
    expect(result.linksSkippedNoMatch).toBe(0);
    expect(result.linksErrored).toBe(0);
  });

  test("idempotent: re-running the sweep over already-linked rows does not duplicate", async () => {
    const rows: FakeTranscriptRow[] = [
      { agentSessionId: "agent-1", cwd: `${SESSIONS_DIR}/${SESSION_A}` },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore);

    await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);
    expect(linkStore.size).toBe(1);

    const result2 = await backfillCwdMatchLinks(asBackfillPg(db), SESSIONS_DIR);
    expect(linkStore.size).toBe(1);
    // Second sweep still counts the row as "written" (idempotent success),
    // not skipped — it matched the cwd pattern, ON CONFLICT DO NOTHING just
    // means no new row was physically inserted.
    expect(result2.linksWritten).toBe(1);
    expect(result2.linksErrored).toBe(0);
  });
});
