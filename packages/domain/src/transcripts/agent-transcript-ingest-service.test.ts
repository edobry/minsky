/**
 * Tests for AgentTranscriptIngestService.
 *
 * Uses in-memory fakes for the DB and TranscriptSource — no real Postgres or
 * file system access.
 *
 * @see mt#1351 — AgentTranscriptIngestService
 */

import { describe, test, expect } from "bun:test";

import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { AgentTranscriptIngestService } from "./agent-transcript-ingest-service";
import type { IngestAllResult } from "./agent-transcript-ingest-service";
import { getSessionsDir } from "@minsky/shared/paths";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const SESSION_C = "cccccccc-0000-0000-0000-000000000003";
const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
const TS3 = "2026-01-01T12:00:00.000Z";

// ── Fake TranscriptSource ────────────────────────────────────────────────────

class FakeTranscriptSource implements TranscriptSource {
  readonly harness = "claude_code";

  private readonly sessionsMap = new Map<string, RawTurnLine[]>();
  private readonly discoveredMap = new Map<string, DiscoveredSession>();

  addSession(sessionId: string, lines: RawTurnLine[], mtime?: Date): void {
    this.sessionsMap.set(sessionId, lines);
    this.discoveredMap.set(sessionId, {
      agentSessionId: sessionId,
      jsonlPath: `/fake/projects/proj/${sessionId}.jsonl`,
      harness: this.harness,
      isSubagent: false,
      mtime: mtime ?? new Date("2026-01-01T00:00:00Z"),
    });
  }

  async *discoverSessions(): AsyncIterable<DiscoveredSession> {
    for (const session of this.discoveredMap.values()) {
      yield session;
    }
  }

  async *readSession(agentSessionId: string): AsyncIterable<RawTurnLine> {
    const lines = this.sessionsMap.get(agentSessionId) ?? [];
    for (const line of lines) {
      yield line;
    }
  }

  getJsonlTimestamp(line: RawTurnLine): string | undefined {
    return typeof line.timestamp === "string" ? line.timestamp : undefined;
  }
}

// ── In-memory DB row store ────────────────────────────────────────────────────

interface FakeRow {
  agentSessionId: string;
  harness: string;
  transcript: RawTurnLine[];
  startedAt: Date | null;
  endedAt: Date | null;
  cwd: string | null;
  projectDir: string | null;
  lastIngestedJsonlTimestamp: Date | null;
  ingestedAt: Date;
}

/** Fake `minsky_session_links` row (mt#2441 — cwd_match link writer). */
interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

/**
 * Creates a minimal fake DB that mimics drizzle's fluent builder surface.
 *
 * The service issues queries in a fixed sequence for each session:
 *   (1) select { lastIngestedJsonlTimestamp } ... where agentSessionId = X  → high-water read
 *   (2) select { agentSessionId } ... where agentSessionId = X              → existence check
 *   (3) select { transcript, cwd } ... where agentSessionId = X             → transcript+cwd read
 *   (4) update … / insert …
 *
 * Because we cannot inspect the opaque drizzle SQL expression returned by
 * eq(), the fake resolves "which session" by tracking the most-recently
 * inserted/active session ID.  Each ingestSession() call touches exactly one
 * session, so the one-at-a-time ordering is deterministic.
 *
 * `linkState` (mt#2441) is a SEPARATE store for `minsky_session_links` writes,
 * keyed independently from the `agent_transcripts` `FakeRow` store above so a
 * cwd_match link write can never corrupt transcript state. Routing is by duck
 * typing: a values object carrying `minskySessionId` + `linkType` (fields no
 * other table's insert carries) is a link write; everything else falls
 * through to the existing agent_transcripts/turns/attachments handling.
 */
function makeDb(state: Map<string, FakeRow>, linkState: Map<string, FakeLinkRow> = new Map()) {
  // The select chain needs to know which session to look up.  We derive it
  // from the insert/update stream: each insert sets currentSid; each
  // subsequent select chain uses it.  For the very first select (high-water
  // read), we prime currentSid from the source session via primeSession().
  let currentSid: string | null = null;

  const db = {
    /** Called by test setup to tell the fake which session is being processed. */
    _primeSession(sid: string) {
      currentSid = sid;
    },

    /** Exposed so tests can assert on written `minsky_session_links` rows. */
    _links: linkState,

    select(fields?: Record<string, unknown>) {
      const fieldKeys = fields ? Object.keys(fields) : [];
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            limit: (_n: number): Promise<Partial<FakeRow>[]> => {
              const sid = currentSid;
              if (!sid) return Promise.resolve([]);
              const row = state.get(sid);
              if (!row) return Promise.resolve([]);
              if (fieldKeys.length === 0) return Promise.resolve([row]);
              const proj: Partial<FakeRow> = {};
              for (const f of fieldKeys) {
                (proj as unknown as Record<string, unknown>)[f] = (
                  row as unknown as Record<string, unknown>
                )[f];
              }
              return Promise.resolve([proj]);
            },
          }),
        }),
      };
    },

    insert(_table: unknown) {
      return {
        values(values: (Partial<FakeRow> & { agentSessionId: string }) | FakeLinkRow) {
          // mt#2441: minsky_session_links writes are duck-typed by the
          // presence of `minskySessionId` + `linkType` — fields no other
          // table's insert carries. Routed to a dedicated store so a link
          // write can never corrupt agent_transcripts state.
          if ("minskySessionId" in values && "linkType" in values) {
            const linkValues = values as FakeLinkRow;
            return {
              onConflictDoNothing(): Promise<void> {
                const key = `${linkValues.agentSessionId}:${linkValues.minskySessionId}`;
                if (!linkState.has(key)) {
                  linkState.set(key, { ...linkValues });
                }
                return Promise.resolve();
              },
            };
          }

          const sid = values.agentSessionId;
          currentSid = sid;

          // Plain-insert path: awaiting `.values(...)` directly performs the insert
          // and overwrites any existing row (matches drizzle's INSERT semantics).
          const doPlainInsert = (): Promise<void> => {
            state.set(sid, {
              agentSessionId: sid,
              harness: values.harness ?? "claude_code",
              transcript: (values.transcript ?? []) as RawTurnLine[],
              startedAt: values.startedAt ?? null,
              endedAt: values.endedAt ?? null,
              cwd: values.cwd ?? null,
              projectDir: values.projectDir ?? null,
              lastIngestedJsonlTimestamp: values.lastIngestedJsonlTimestamp ?? null,
              ingestedAt: values.ingestedAt ?? new Date(),
            });
            return Promise.resolve();
          };

          // Returns a thenable so plain `await db.insert(...).values(...)` still
          // works, but also exposes `.onConflictDoUpdate(...)` for the upsert
          // path. The fake doesn't introspect the conflict target or the SQL
          // expressions in `set`; it hard-codes the production convention
          // (mt#2789): `transcript` is JSONB-array concatenated but filtered
          // by line `uuid` — an EXCLUDED element whose `uuid` is already
          // present in the stored array is dropped (elements without a
          // `uuid` are always appended), mirroring the correlated
          // `jsonb_array_elements` subquery in the real SQL.
          // `lastIngestedJsonlTimestamp` takes GREATEST(existing, EXCLUDED)
          // rather than a flat overwrite. Scalar fields otherwise copy from
          // EXCLUDED (i.e. the inserted values).
          return {
            then: <T>(resolve: (v: void) => T, reject?: (e: unknown) => unknown) =>
              doPlainInsert().then(resolve, reject),
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              const existing = state.get(sid);
              if (!existing) return doPlainInsert();

              const existingUuids = new Set(
                (existing.transcript ?? [])
                  .map((l) => l.uuid)
                  .filter((u): u is string => typeof u === "string")
              );
              const incoming = (values.transcript ?? []) as RawTurnLine[];
              const deduped = incoming.filter(
                (l) => typeof l.uuid !== "string" || !existingUuids.has(l.uuid)
              );
              const concatenated: RawTurnLine[] = [...(existing.transcript ?? []), ...deduped];

              const existingHwm = existing.lastIngestedJsonlTimestamp;
              const incomingHwm = values.lastIngestedJsonlTimestamp ?? null;
              const newHwm =
                existingHwm && incomingHwm
                  ? existingHwm.getTime() >= incomingHwm.getTime()
                    ? existingHwm
                    : incomingHwm
                  : (incomingHwm ?? existingHwm);

              state.set(sid, {
                ...existing,
                transcript: concatenated,
                endedAt: values.endedAt ?? existing.endedAt,
                lastIngestedJsonlTimestamp: newHwm,
                ingestedAt: values.ingestedAt ?? new Date(),
              });
              return Promise.resolve();
            },
          };
        },
      };
    },

    update(_table: unknown) {
      return {
        set(updates: Partial<FakeRow>) {
          return {
            where(_cond: unknown): Promise<void> {
              if (currentSid) {
                const existing = state.get(currentSid);
                if (existing) {
                  state.set(currentSid, { ...existing, ...updates });
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return db;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeLines(timestamps: string[], type = "user"): RawTurnLine[] {
  return timestamps.map((ts, i) => ({
    type,
    timestamp: ts,
    uuid: `uuid-${i}`,
    message: { role: type, content: `content-${i}` },
  }));
}

function makeDiscovered(sessionId: string): DiscoveredSession {
  return {
    agentSessionId: sessionId,
    jsonlPath: `/fake/projects/proj/${sessionId}.jsonl`,
    harness: "claude_code",
    isSubagent: false,
    mtime: new Date(TS3),
  };
}

type FakeDbType = ReturnType<typeof makeDb>;

function makeSvc(db: FakeDbType, source: FakeTranscriptSource): AgentTranscriptIngestService {
  return new AgentTranscriptIngestService(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    source
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AgentTranscriptIngestService", () => {
  describe("ingestSession", () => {
    test("inserts transcript rows on first ingest", async () => {
      const lines = makeLines([TS1, TS2]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      // Prime so the HWM select resolves correctly (returns [] since state is empty).
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.ingested).toBe(2);
      expect(result.error).toBeUndefined();
      const row = state.get(SESSION_A);
      expect(row).toBeDefined();
      expect((row?.transcript as RawTurnLine[]).length).toBe(2);
    });

    test("returns 0 for empty session", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, []);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.ingested).toBe(0);
      expect(result.error).toBeUndefined();
      expect(state.size).toBe(0);
    });

    test("returns 0 for lines without timestamps", async () => {
      const lines: RawTurnLine[] = [
        { type: "user", message: { role: "user", content: "hello" } },
        { type: "assistant", message: { role: "assistant", content: "world" } },
      ];
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.ingested).toBe(0);
      expect(result.error).toBeUndefined();
      expect(state.size).toBe(0);
    });

    test("stores lastIngestedJsonlTimestamp equal to the latest line timestamp", async () => {
      const lines = makeLines([TS1, TS2, TS3]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      await svc.ingestSession(makeDiscovered(SESSION_A));

      const row = state.get(SESSION_A);
      expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS3);
    });

    test("incremental: skips lines at or before high-water-mark", async () => {
      // Pre-seed state with TS1+TS2 already ingested; HWM = TS2.
      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: makeLines([TS1, TS2]),
        startedAt: new Date(TS1),
        endedAt: new Date(TS2),
        cwd: null,
        projectDir: null,
        lastIngestedJsonlTimestamp: new Date(TS2),
        ingestedAt: new Date(),
      });

      // Source now has all three lines (JSONL grew).
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2, TS3]));
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      // Only TS3 should be new.
      expect(result.ingested).toBe(1);
      expect(result.error).toBeUndefined();

      const row = state.get(SESSION_A);
      // Updated HWM should be TS3.
      expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS3);
    });

    test("no-op when all lines are at or before high-water-mark", async () => {
      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: makeLines([TS1, TS2]),
        startedAt: new Date(TS1),
        endedAt: new Date(TS2),
        cwd: null,
        projectDir: null,
        lastIngestedJsonlTimestamp: new Date(TS2),
        ingestedAt: new Date(),
      });

      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2])); // same lines, no new ones
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.ingested).toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe("idempotent uuid-based append under concurrent-ingest race (mt#2789)", () => {
    // The mt#2789 diagnosis found the observed duplicate-tool-result bug was
    // a concurrent-ingest race: two actors both read the SAME (now-stale)
    // high-water-mark before either committed, so both collect the same "new"
    // batch and both reach the upsert. These tests simulate that by forcing
    // the HWM select to always report "no prior ingest" (null) across
    // multiple `ingestSession` calls — defeating the in-process HWM gate the
    // same way a genuinely concurrent second reader would, so the SQL-level
    // (here, fake-DB-mirrored) uuid dedup is what has to prevent duplication.

    test("(a) the identical batch ingested twice results in each line stored exactly once", async () => {
      const lines = makeLines([TS1, TS2]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);
      (db as Record<string, unknown>).select = () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      });

      const svc = makeSvc(db, source);

      const first = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(first.error).toBeUndefined();
      expect(first.ingested).toBe(2);

      db._primeSession(SESSION_A);
      const second = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(second.error).toBeUndefined();

      const row = state.get(SESSION_A);
      const stored = (row?.transcript ?? []) as RawTurnLine[];
      expect(stored.length).toBe(2);
      expect(new Set(stored.map((l) => l.uuid)).size).toBe(2);
    });

    test("(b) two overlapping batches (stale prefix, then full re-read) append only the new tail", async () => {
      const allLines = makeLines([TS1, TS2, TS3]);

      // The first "actor" only saw the first two lines (its JSONL snapshot
      // was taken before the third line was written).
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, allLines.slice(0, 2));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);
      (db as Record<string, unknown>).select = () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      });

      const svc = makeSvc(db, source);
      const first = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(first.error).toBeUndefined();
      expect(first.ingested).toBe(2);

      // A second "actor" (or the same one on its next pass) sees the FULL
      // file. Its own HWM read is also stale (forced null), so it re-collects
      // the prefix it already ingested PLUS the new tail line.
      source.addSession(SESSION_A, allLines);
      db._primeSession(SESSION_A);
      const second = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(second.error).toBeUndefined();
      expect(second.ingested).toBe(3); // collected all 3 (HWM forced null)

      const row = state.get(SESSION_A);
      const stored = (row?.transcript ?? []) as RawTurnLine[];
      expect(stored.length).toBe(3);
      expect(stored.map((l) => l.uuid)).toEqual(["uuid-0", "uuid-1", "uuid-2"]);
    });

    test("(c) lines without a uuid do not crash the merge and are always appended (never deduped)", async () => {
      const noUuidLine: RawTurnLine = {
        type: "user",
        timestamp: TS1,
        message: { role: "user", content: "no-uuid-line" },
        // `uuid` intentionally omitted — decision recorded at the mt#2789
        // upsert site: a missing uuid is always appended, not treated as a
        // duplicate and not a crash, since Claude Code's retained
        // user/assistant lines always carry one in practice.
      };
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [noUuidLine]);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);
      (db as Record<string, unknown>).select = () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      });

      const svc = makeSvc(db, source);
      const first = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(first.error).toBeUndefined();
      expect(first.ingested).toBe(1);

      db._primeSession(SESSION_A);
      const second = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(second.error).toBeUndefined();

      // No crash; per the documented decision, both copies are kept (a
      // missing uuid can never match the dedup filter, so it's always
      // appended rather than silently dropped).
      const row = state.get(SESSION_A);
      const stored = (row?.transcript ?? []) as RawTurnLine[];
      expect(stored.length).toBe(2);
      expect(stored.every((l) => l.uuid === undefined)).toBe(true);
    });

    test("lastIngestedJsonlTimestamp never regresses (GREATEST) when a stale racing actor's batch is older", async () => {
      // A fast actor already advanced HWM to TS3 with all three lines stored.
      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: makeLines([TS1, TS2, TS3]),
        startedAt: new Date(TS1),
        endedAt: new Date(TS3),
        cwd: null,
        projectDir: null,
        lastIngestedJsonlTimestamp: new Date(TS3),
        ingestedAt: new Date(),
      });

      // A slow racing actor's own JSONL snapshot only went up to TS2 (it read
      // the file before the TS3 line was appended). Its HWM read is ALSO
      // stale (forced null), so it re-collects [TS1, TS2] as "new" and its
      // own latestTs (TS2) is older than what's already stored (TS3).
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2]));

      const db = makeDb(state);
      db._primeSession(SESSION_A);
      (db as Record<string, unknown>).select = () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      });

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(result.error).toBeUndefined();

      const row = state.get(SESSION_A);
      // Watermark must not regress from TS3 down to TS2.
      expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS3);
      // No duplicate lines — the stale actor's TS1/TS2 lines were already stored.
      expect((row?.transcript as RawTurnLine[]).length).toBe(3);
    });
  });

  describe("cwd_match link writing (mt#2441)", () => {
    test("writes a cwd_match link when the transcript cwd is under the sessions dir", async () => {
      const workspaceSessionId = "workspace-session-abc";
      const cwd = `${getSessionsDir()}/${workspaceSessionId}`;

      const lines = makeLines([TS1]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const discovered: DiscoveredSession = { ...makeDiscovered(SESSION_A), cwd };
      const result = await svc.ingestSession(discovered);

      expect(result.error).toBeUndefined();
      const link = linkState.get(`${SESSION_A}:${workspaceSessionId}`);
      expect(link).toBeDefined();
      expect(link?.linkType).toBe("cwd_match");
      expect(link?.confidence).toBe(1.0);
    });

    test("writes a descendant-confidence link when cwd is nested under the session dir", async () => {
      const workspaceSessionId = "workspace-session-def";
      const cwd = `${getSessionsDir()}/${workspaceSessionId}/src/nested`;

      const lines = makeLines([TS1]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const discovered: DiscoveredSession = { ...makeDiscovered(SESSION_A), cwd };
      await svc.ingestSession(discovered);

      const link = linkState.get(`${SESSION_A}:${workspaceSessionId}`);
      expect(link).toBeDefined();
      expect(link?.confidence).toBe(0.8);
    });

    test("does not write a link when cwd does not resolve to a session workspace path", async () => {
      const lines = makeLines([TS1]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const discovered: DiscoveredSession = {
        ...makeDiscovered(SESSION_A),
        cwd: "/some/unrelated/project/dir",
      };
      const result = await svc.ingestSession(discovered);

      expect(result.error).toBeUndefined();
      expect(linkState.size).toBe(0);
    });

    test("does not write a link and does not fail ingest when cwd is absent", async () => {
      const lines = makeLines([TS1]);
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, lines);
      const state = new Map<string, FakeRow>();
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      // makeDiscovered() doesn't set cwd — mirrors a source that couldn't
      // recover the working directory (mt#1445).
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.error).toBeUndefined();
      expect(linkState.size).toBe(0);
    });

    test("idempotent: re-ingesting the same session does not duplicate the link row", async () => {
      const workspaceSessionId = "workspace-session-idempotent";
      const cwd = `${getSessionsDir()}/${workspaceSessionId}`;

      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2]));
      const state = new Map<string, FakeRow>();
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const discovered: DiscoveredSession = { ...makeDiscovered(SESSION_A), cwd };

      await svc.ingestSession(discovered);
      expect(linkState.size).toBe(1);

      // Re-run over the same (now unchanged) source — HWM gate makes this an
      // ingest no-op, but even a fresh insert attempt would hit
      // ON CONFLICT DO NOTHING and not duplicate the row.
      db._primeSession(SESSION_A);
      await svc.ingestSession(discovered);
      expect(linkState.size).toBe(1);
    });

    test("writes a link from session.cwd even when the persisted cwd is still NULL (PR #1899 R1)", async () => {
      // Reproduces the reviewer-bot R1 finding: a session first ingested
      // before its cwd was recoverable (persisted cwd stays NULL forever —
      // the agent_transcripts upsert never updates cwd on conflict, mt#1445)
      // must still get linked once a LATER ingest call's DiscoveredSession
      // carries a resolvable session.cwd, even though the stored column
      // never catches up.
      const workspaceSessionId = "workspace-session-late-cwd";
      const cwd = `${getSessionsDir()}/${workspaceSessionId}`;

      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: makeLines([TS1]),
        startedAt: new Date(TS1),
        endedAt: new Date(TS1),
        cwd: null, // first ingest happened before cwd was recoverable
        projectDir: null,
        lastIngestedJsonlTimestamp: new Date(TS1),
        ingestedAt: new Date(),
      });
      const linkState = new Map<string, FakeLinkRow>();
      const db = makeDb(state, linkState);
      db._primeSession(SESSION_A);

      const source = new FakeTranscriptSource();
      // JSONL grew: a new line at TS2 triggers a re-ingest.
      source.addSession(SESSION_A, makeLines([TS1, TS2]));

      const svc = makeSvc(db, source);
      const discovered: DiscoveredSession = { ...makeDiscovered(SESSION_A), cwd };
      const result = await svc.ingestSession(discovered);

      expect(result.error).toBeUndefined();
      // Persisted cwd is still NULL — onConflictDoUpdate never touches it.
      expect(state.get(SESSION_A)?.cwd).toBeNull();
      // But the link was written from session.cwd, not the stale persisted value.
      const link = linkState.get(`${SESSION_A}:${workspaceSessionId}`);
      expect(link).toBeDefined();
      expect(link?.confidence).toBe(1.0);
    });
  });

  describe("ingestAll", () => {
    test("sweeps all discovered sessions and returns aggregate counts", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2]));
      source.addSession(SESSION_B, makeLines([TS3]));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      // ingestAll iterates sessions one at a time; each insert primes currentSid.

      const svc = makeSvc(db, source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(2);
      expect(result.sessionsErrored).toBe(0);
      expect(result.totalIngested).toBe(3); // TS1+TS2 from A, TS3 from B
    });

    test("a session DB error is counted via the typed result and does not abort the sweep", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));
      source.addSession(SESSION_B, makeLines([TS2]));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);

      // Make the first upsert throw. Production code awaits
      // `.insert(...).values(...).onConflictDoUpdate(...)`, so the override
      // must surface the simulated error from the awaited terminal call.
      let upsertCount = 0;
      const origInsert = db.insert.bind(db);
      (db as Record<string, unknown>).insert = (_table: unknown) => ({
        values: (values: Partial<FakeRow> & { agentSessionId: string }) => {
          const realChain = origInsert(_table).values(values);
          return {
            then: realChain.then.bind(realChain),
            onConflictDoUpdate: (opts: unknown): Promise<void> => {
              upsertCount++;
              if (upsertCount === 1) return Promise.reject(new Error("simulated DB error"));
              return realChain.onConflictDoUpdate(opts);
            },
          };
        },
      });

      const svc = makeSvc(db, source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(2);
      // mt#1444: ingestSession now returns { ingested, error? } so the swallowed
      // upsert failure surfaces and is counted in sessionsErrored honestly.
      expect(result.sessionsErrored).toBe(1);
      // The other session succeeded.
      expect(result.totalIngested).toBe(1);
    });

    test("upsert failure increments sessionsErrored for that session", async () => {
      // mt#1444 acceptance test (variant): one session in three errors at upsert;
      // sessionsErrored counts exactly one even though the sweep doesn't abort.
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));
      source.addSession(SESSION_B, makeLines([TS2]));
      source.addSession(SESSION_C, makeLines([TS3]));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);

      // Throw on session B's TRANSCRIPT upsert, let A and C succeed. We key on
      // the session + the presence of the `transcript` field so the failure
      // targets the agent_transcripts upsert specifically — ingestSession also
      // issues per-turn upserts now (ADR-019, mt#2381), which carry `turnIndex`
      // (not `transcript`) and must not be the thing we fail here.
      const origInsert = db.insert.bind(db);
      (db as Record<string, unknown>).insert = (_table: unknown) => ({
        values: (values: Partial<FakeRow> & { agentSessionId: string }) => {
          const realChain = origInsert(_table).values(values);
          const isSessionBTranscriptUpsert =
            values.agentSessionId === SESSION_B && "transcript" in values;
          return {
            then: realChain.then.bind(realChain),
            onConflictDoUpdate: (opts: unknown): Promise<void> => {
              if (isSessionBTranscriptUpsert) {
                return Promise.reject(new Error("simulated DB error"));
              }
              return realChain.onConflictDoUpdate(opts);
            },
          };
        },
      });

      const svc = makeSvc(db, source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(3);
      expect(result.sessionsErrored).toBe(1);
      expect(result.totalIngested).toBe(2); // A and C succeeded, B failed
    });

    test("HWM-read failure is surfaced via the typed result and counted", async () => {
      // mt#1444 acceptance test, updated for mt#2789: HWM-read failure on one
      // session counts in sessionsErrored. Post-mt#2789, ingestSession no
      // longer recovers and proceeds on a HWM-read failure — it aborts the
      // session's ingest immediately (see the abort-vs-proceed rationale at
      // the HWM read site in the source). So this session also contributes
      // 0 to totalIngested and never reaches the upsert.
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      // Override the HWM select to throw.
      (db as Record<string, unknown>).select = () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.reject(new Error("simulated HWM-read failure")),
          }),
        }),
      });

      const svc = makeSvc(db, source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessionsErrored).toBe(1);
      // mt#2789: the abort path means nothing was ingested for this session.
      expect(result.totalIngested).toBe(0);
      expect(state.size).toBe(0);
    });

    test("sweep over empty source returns zero counts", async () => {
      const source = new FakeTranscriptSource();
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);

      const svc = makeSvc(db, source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(0);
      expect(result.totalIngested).toBe(0);
      expect(result.sessionsErrored).toBe(0);
    });
  });
});
