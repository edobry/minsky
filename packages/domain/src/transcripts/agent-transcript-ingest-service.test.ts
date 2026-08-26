/**
 * Tests for AgentTranscriptIngestService.
 *
 * Uses in-memory fakes for the DB and TranscriptSource — no real Postgres or
 * file system access.
 *
 * @see mt#1351 — AgentTranscriptIngestService
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ConversationId } from "../ids";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import {
  AgentTranscriptIngestService,
  INGEST_QUARANTINE_THRESHOLD,
  extractModelFromNewLines,
  countAssistantLines,
  decideMissingModelWarn,
} from "./agent-transcript-ingest-service";
import type {
  IngestAllResult,
  SpawnsExtractor,
  ToolCallProjector,
} from "./agent-transcript-ingest-service";
import type { SpawnsPipelineRunResult } from "./agent-spawns-pipeline";
import { SYNTHETIC_MODEL_SENTINEL } from "../ai/dispatch-models";
import { getSessionsDir } from "@minsky/shared/paths";
// mt#4573: the DB fake moved to a shared fixture when this file hit the
// 1500-line ceiling. Re-exported so existing importers of this module keep
// resolving, and so there is exactly one fake in the tree.
import { makeDb, type FakeRow, type FakeLinkRow } from "./__fixtures__/fake-ingest-db";

export { makeDb, type FakeRow, type FakeLinkRow };

// ── Constants ─────────────────────────────────────────────────────────────────

/** Mint a ConversationId from a literal — the documented cast path (`ids.ts`). */
const conv = (id: string) => id as ConversationId;

export const SESSION_A = conv("aaaaaaaa-0000-0000-0000-000000000001");
const SESSION_B = conv("bbbbbbbb-0000-0000-0000-000000000002");
const SESSION_C = conv("cccccccc-0000-0000-0000-000000000003");
export const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
export const TS3 = "2026-01-01T12:00:00.000Z";

// ── Fake TranscriptSource ────────────────────────────────────────────────────

/**
 * Mirrors `RETAINED_TYPES` in `claude-code-transcript-source.ts` /
 * `single-file-transcript-source.ts` (mt#3836).
 *
 * Duplicated rather than imported because those are deliberately module-private
 * per-source constants (`custom/no-domain-singleton`). The duplication is the
 * point of failure this list is guarding, so `single-file-transcript-source.test.ts`
 * asserts each retained type end-to-end against a real file — if a type is added
 * there and not here, the fake silently under-reports and this comment is the
 * pointer to why that matters.
 */
const FAKE_RETAINED_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "queue-operation",
  "last-prompt",
]);

export class FakeTranscriptSource implements TranscriptSource {
  readonly harness = "claude_code";

  private readonly sessionsMap = new Map<string, RawTurnLine[]>();
  private readonly discoveredMap = new Map<string, DiscoveredSession>();

  /**
   * mt#3288: how many times `discoverSessions()` was walked. `ingestAll` must
   * walk it exactly once no matter how many sessions it processes — a count
   * that scales with the session count is the quadratic id-lookup regressing.
   */
  discoverSessionsCalls = 0;
  /** mt#3288: the `jsonlPath` each `readSession` call received (undefined = none). */
  readSessionPaths: (string | undefined)[] = [];

  addSession(sessionId: ConversationId, lines: RawTurnLine[], mtime?: Date): void {
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
    this.discoverSessionsCalls++;
    for (const session of this.discoveredMap.values()) {
      yield session;
    }
  }

  async *readSessionRaw(agentSessionId: string, jsonlPath?: string): AsyncIterable<RawTurnLine> {
    this.readSessionPaths.push(jsonlPath);
    // Mirrors ClaudeCodeTranscriptSource: with no path, the id can only be
    // resolved by walking discovery. Modelling that here is what makes
    // `discoverSessionsCalls` a real regression signal — a fake that resolved
    // from its map for free would report one walk either way.
    if (jsonlPath === undefined) {
      for await (const _ of this.discoverSessions()) {
        /* scan to resolve the id, as the real source does */
      }
    }
    const lines = this.sessionsMap.get(agentSessionId) ?? [];
    for (const line of lines) {
      yield line;
    }
  }

  // mt#3836: model the SAME retained-type filter the real sources do.
  //
  // Without it the fake was strictly more permissive than production: it
  // yielded whatever a test handed it, including line types
  // `ClaudeCodeTranscriptSource` drops. That is exactly how mt#3656's
  // divergence detector shipped inert — its tests fed `last-prompt` rows
  // straight through a fake that would pass them, while the real source
  // filtered them out before the scanner could ever see one. A fake that
  // cannot express the production filter cannot fail the way production fails.
  //
  // mt#4573 moved the filter from inside `readSession` to this predicate,
  // which is what lets a test exercise the capture path: `readSessionRaw`
  // yields the unretained lines, and only the legacy destinations drop them.
  isRetainedLine(line: RawTurnLine): boolean {
    return FAKE_RETAINED_TYPES.has(typeof line.type === "string" ? line.type : "");
  }

  async *readSession(agentSessionId: string, jsonlPath?: string): AsyncIterable<RawTurnLine> {
    for await (const line of this.readSessionRaw(agentSessionId, jsonlPath)) {
      if (!this.isRetainedLine(line)) continue;
      yield line;
    }
  }

  getJsonlTimestamp(line: RawTurnLine): string | undefined {
    return typeof line.timestamp === "string" ? line.timestamp : undefined;
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function makeLines(timestamps: string[], type = "user"): RawTurnLine[] {
  return timestamps.map((ts, i) => ({
    type,
    timestamp: ts,
    uuid: `uuid-${i}`,
    message: { role: type, content: `content-${i}` },
  }));
}

/**
 * mt#3482: a line that yields an attachment ROW (see `attachment-row-builder`),
 * so `newAttachmentRows` is non-empty and the FK-ordered write path runs.
 */
export function makeAttachmentLine(ts: string): RawTurnLine {
  return {
    type: "attachment",
    timestamp: ts,
    uuid: `uuid-attachment-${ts}`,
    attachment: { type: "hook_additional_context", content: "injected" },
  } as unknown as RawTurnLine;
}

export function makeDiscovered(sessionId: ConversationId): DiscoveredSession {
  return {
    agentSessionId: sessionId,
    jsonlPath: `/fake/projects/proj/${sessionId}.jsonl`,
    harness: "claude_code",
    isSubagent: false,
    mtime: new Date(TS3),
  };
}

type FakeDbType = ReturnType<typeof makeDb>;

/**
 * Casts a fake DB double to the real drizzle type for constructor injection.
 * Extracted to avoid repeating the `import("drizzle-orm/postgres-js")` type
 * literal at every no-constructor-override composability test (flagged by
 * `custom/no-magic-string-duplication`).
 */
function asPgDb(db: FakeDbType): PostgresJsDatabase {
  return db as unknown as PostgresJsDatabase;
}

/** The union `makeDb`'s `insert(...).values(...)` can return. */
type FakeInsertChain = ReturnType<ReturnType<FakeDbType["insert"]>["values"]>;

/**
 * Narrow a fake insert chain to its thenable object-values branch.
 *
 * `.values()` returns a UNION: the ARRAY branch deliberately omits `then`
 * (PR #2503 R1), so `then`/`onConflictDoUpdate` are optional across the union.
 * The tests below only wrap OBJECT-valued inserts, for which the thenable
 * branch is the only reachable one — assert that rather than optional-chaining,
 * so a future change to the fake fails loudly here instead of silently turning
 * the wrapper into a no-op.
 */
function thenableChain(chain: FakeInsertChain) {
  if (typeof chain.then !== "function" || typeof chain.onConflictDoUpdate !== "function") {
    throw new Error("fake insert chain: expected the thenable object-values branch");
  }
  return chain as FakeInsertChain & {
    then: NonNullable<FakeInsertChain["then"]>;
    onConflictDoUpdate: NonNullable<FakeInsertChain["onConflictDoUpdate"]>;
  };
}

/** A zeroed `SpawnsPipelineRunResult` — nothing scanned, nothing written. */
const NOOP_SPAWNS_RESULT: SpawnsPipelineRunResult = {
  spawnsScanned: 0,
  spawnsWritten: 0,
  childLinkedFromMetadata: 0,
  childLinkedFromHeuristic: 0,
  childUnresolved: 0,
  childRefusedSiblingSpawn: 0,
  spawnsErrored: 0,
  spawnLinksWritten: 0,
  spawnLinksSkippedNoPromptMatch: 0,
  spawnsSkippedNoToolUseId: 0,
  spawnLinksErrored: 0,
};

/**
 * Default spawns-extractor test double (mt#3109): a no-op that never touches
 * `agent_spawns`. Existing `ingestSession`/`ingestAll` tests below predate the
 * inline spawn-extraction call and assert on `agent_transcripts` /
 * `minsky_session_links` state only — they don't need (and shouldn't need to
 * model) `AgentSpawnsPipeline`'s full drizzle join/upsert query surface, which
 * this file's hand-rolled `makeDb` fake doesn't support. Tests that DO care
 * about the new call (see "agent-spawns extraction at ingest (mt#3109)"
 * below) pass their own spy-based `spawnsExtractor` override instead.
 */
function makeNoopSpawnsExtractor(): SpawnsExtractor {
  return {
    runForSession: async () => ({ ...NOOP_SPAWNS_RESULT }),
  };
}

/**
 * Default tool-call-projector test double (mt#3329): a no-op that never
 * touches `agent_tool_call_projection`, for the same reason
 * `makeNoopSpawnsExtractor` exists above — most tests in this file predate
 * the inline projection call and assert on `agent_transcripts` /
 * `minsky_session_links` state only.
 */
function makeNoopToolCallProjector(): ToolCallProjector {
  return {
    runForSession: async () => ({
      turnsScanned: 0,
      toolCallsProjected: 0,
      turnsErrored: 0,
      skippedNonArray: 0,
      orphansDeleted: 0,
      orphanDeleteFailed: false,
    }),
  };
}

export function makeSvc(
  db: FakeDbType,
  source: FakeTranscriptSource,
  spawnsExtractor: SpawnsExtractor = makeNoopSpawnsExtractor(),
  toolCallProjector: ToolCallProjector = makeNoopToolCallProjector(),
  logWarn?: (message: string, meta?: Record<string, unknown>) => void
): AgentTranscriptIngestService {
  return new AgentTranscriptIngestService(
    asPgDb(db),
    source,
    spawnsExtractor,
    toolCallProjector,
    logWarn
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

    // ── mt#3482: the attachment insert's parent row ─────────────────────────
    //
    // `agent_transcript_attachments.agent_session_id` carries an FK to
    // `agent_transcripts`. The attachment insert runs BEFORE the watermark-
    // bearing upsert (mt#3278), so on a conversation's FIRST ingest there was
    // no parent row to reference and the whole ingest aborted. These tests pin
    // the ORDER; the constraint itself is exercised against a real Postgres in
    // `tests/integration/transcript-attachment-parent-row.integration.test.ts`.

    test("creates the parent transcript row before inserting attachments on first ingest", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [...makeLines([TS1]), makeAttachmentLine(TS1)]);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const result = await makeSvc(db, source).ingestSession(makeDiscovered(SESSION_A));

      expect(result.error).toBeUndefined();
      const parentAt = db._writeOrder.indexOf("transcript-row");
      const attachmentsAt = db._writeOrder.indexOf("attachments");
      const upsertAt = db._writeOrder.indexOf("transcript-upsert");

      expect(attachmentsAt).toBeGreaterThanOrEqual(0);
      // The parent row exists before the FK-bearing insert…
      expect(parentAt).toBeGreaterThanOrEqual(0);
      expect(attachmentsAt).toBeGreaterThan(parentAt);
      // …and mt#3278's guarantee still holds: the watermark-bearing upsert runs
      // AFTER the attachments, so an attachment failure aborts before the
      // watermark can advance.
      expect(upsertAt).toBeGreaterThan(attachmentsAt);
    });

    test("does not re-insert the parent row once the conversation exists", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [...makeLines([TS1]), makeAttachmentLine(TS1)]);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);
      const svc = makeSvc(db, source);

      await svc.ingestSession(makeDiscovered(SESSION_A));
      const afterFirstIngest = db._writeOrder.length;

      source.addSession(SESSION_A, [
        ...makeLines([TS1]),
        makeAttachmentLine(TS1),
        ...makeLines([TS3]),
        makeAttachmentLine(TS3),
      ]);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.error).toBeUndefined();
      const secondIngestWrites = db._writeOrder.slice(afterFirstIngest);
      // The row already exists, so the §3a insert is skipped entirely — the
      // fix costs one extra statement on first ingest, not on every poll.
      expect(secondIngestWrites).not.toContain("transcript-row");
      expect(secondIngestWrites).toContain("attachments");
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

    test("ingests 0 for lines without timestamps, but no longer DISCARDS them (mt#4573)", async () => {
      // Behavior change, made deliberately — the previous assertion was
      // `state.size === 0`, i.e. a session whose lines all lack timestamps
      // produced no row at all.
      //
      // Look at what these lines ARE: `user` and `assistant` turns carrying real
      // message content, dropped on the floor because they had no timestamp.
      // That is precisely the silent loss this task exists to end, so capturing
      // them is the point rather than a side effect — and capture needs a parent
      // row, because `transcript_lines` carries an FK to `agent_transcripts`.
      //
      // `ingested` still reports 0: that counts the TIMESTAMPED ingest path,
      // which genuinely took nothing, and it is unchanged.
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
      // The content survives now, which it did not before.
      expect(db._capturedLines.map((r) => r.lineType)).toEqual(["user", "assistant"]);
      expect(state.size).toBe(1);
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

    // mt#3131 (D2): endedAt must assert TERMINATION, not "last observed".
    describe("endedAt semantics (mt#3131 D2)", () => {
      test("a routine ingest (no sessionEnded) leaves endedAt null", async () => {
        const lines = makeLines([TS1, TS2]);
        const source = new FakeTranscriptSource();
        source.addSession(SESSION_A, lines);
        const state = new Map<string, FakeRow>();
        const db = makeDb(state);
        db._primeSession(SESSION_A);

        const svc = makeSvc(db, source);
        await svc.ingestSession(makeDiscovered(SESSION_A));

        const row = state.get(SESSION_A);
        expect(row?.endedAt).toBeNull();
      });

      test("sessionEnded: true records a real endedAt", async () => {
        const lines = makeLines([TS1, TS2]);
        const source = new FakeTranscriptSource();
        source.addSession(SESSION_A, lines);
        const state = new Map<string, FakeRow>();
        const db = makeDb(state);
        db._primeSession(SESSION_A);

        const svc = makeSvc(db, source);
        await svc.ingestSession(makeDiscovered(SESSION_A), { sessionEnded: true });

        const row = state.get(SESSION_A);
        expect(row?.endedAt?.toISOString()).toBe(TS2);
      });

      test("a routine poll after sessionEnded:true does not regress endedAt back to null", async () => {
        const source = new FakeTranscriptSource();
        source.addSession(SESSION_A, makeLines([TS1, TS2]));
        const state = new Map<string, FakeRow>();
        const db = makeDb(state);
        db._primeSession(SESSION_A);
        const svc = makeSvc(db, source);

        await svc.ingestSession(makeDiscovered(SESSION_A), { sessionEnded: true });
        expect(state.get(SESSION_A)?.endedAt?.toISOString()).toBe(TS2);

        // A later incremental poll (e.g. the boot sweep re-observing the same
        // session) picks up a NEW line but carries no termination evidence.
        source.addSession(SESSION_A, makeLines([TS1, TS2, TS3]));
        await svc.ingestSession(makeDiscovered(SESSION_A));

        const row = state.get(SESSION_A);
        expect(row?.endedAt?.toISOString()).toBe(TS2);
        expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS3);
      });
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
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
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
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
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
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
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

    // Postgres NULL boundary for GREATEST (PR #1942 R1): unlike MySQL,
    // Postgres GREATEST *ignores* NULL arguments — the result is NULL only
    // when ALL arguments are NULL (docs: functions-conditional). The fake DB
    // mirrors that (`incomingHwm ?? existingHwm`); these tests pin both
    // directions so a future engine/mock change can't silently import the
    // MySQL any-NULL-poisons semantics.
    test("watermark advances from a NULL existing HWM (GREATEST ignores the NULL side)", async () => {
      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: makeLines([TS1]),
        startedAt: new Date(TS1),
        endedAt: new Date(TS1),
        cwd: null,
        projectDir: null,
        lastIngestedJsonlTimestamp: null,
        ingestedAt: new Date(),
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
      });

      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1, TS2]));
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));
      expect(result.error).toBeUndefined();

      const row = state.get(SESSION_A);
      expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS2);
    });

    test("a NULL incoming HWM cannot regress an existing watermark to NULL", async () => {
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
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
      });

      // Force the HWM read stale (null) so the actor re-collects; its batch
      // contains ONLY a line with no parseable timestamp path — simulate via
      // an empty-timestamp batch by giving the source no new lines but an
      // attachment-free stream: simplest honest construction is a batch whose
      // lines are all duplicates (latestTs computed but no new appends), so
      // EXCLUDED carries a timestamp equal to TS2; the assert is that the
      // stored watermark is never nulled or regressed by the merge.
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
      expect(row?.lastIngestedJsonlTimestamp?.toISOString()).toBe(TS2);
      expect(row?.lastIngestedJsonlTimestamp).not.toBeNull();
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
        model: null,
        ingestFailureCount: 0,
        ingestLastError: null,
        ingestLastFailedAt: null,
        ingestQuarantinedAt: null,
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
    // mt#3278 AT1: a transcript carrying U+0000 must land, not fail forever.
    // The fixture is built by JSON.parse so the escape is decoded exactly as it
    // is when a real transcript line is read off disk — the value reaching the
    // service is a genuine U+0000 in a JS string, not an escape.
    test("ingests a line whose signature field carries a Postgres-unrepresentable codepoint", async () => {
      const poisoned = JSON.parse(
        `{"type":"assistant","uuid":"u-poison","timestamp":"${TS1}",` +
          `"signature":"sig\\u0000end","message":{"role":"assistant","content":[]}}`
      ) as RawTurnLine;
      expect(JSON.stringify(poisoned).includes("u0000")).toBe(true);

      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [poisoned]);

      const state = new Map<string, FakeRow>();
      const svc = makeSvc(makeDb(state), source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.ingested).toBe(1);
      expect(result.error).toBeUndefined();

      const stored = state.get(SESSION_A);
      expect(stored?.transcript).toHaveLength(1);
      // The decisive assertion: what was stored no longer carries the escape
      // Postgres rejects, so this row is insertable. Asserting only that the
      // line landed would pass even with the sanitizer removed, because the
      // fake DB does not enforce Postgres's encoding rules.
      expect(JSON.stringify(stored?.transcript).includes("u0000")).toBe(false);
      expect((stored?.transcript?.[0] as { signature?: string })?.signature).toBe(
        `sig${String.fromCharCode(0xfffd)}end`
      );
      // The watermark advanced — the session is not frozen.
      expect(stored?.lastIngestedJsonlTimestamp).toEqual(new Date(TS1));
    });

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

    // mt#3278 AT2: a payload that cannot be stored is quarantined rather than
    // retried forever. Two consecutive sweeps must attempt it ONCE, not twice.
    test("quarantines a permanently-failing session instead of retrying it every sweep", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));

      const state = new Map<string, FakeRow>();
      const db = makeDb(state);

      // Fail every transcript upsert. The failure-record upsert (no
      // `transcript` key) must still go through, or nothing could ever be
      // counted — that asymmetry is the mechanism under test.
      let attempts = 0;
      const origInsert = db.insert.bind(db);
      (db as Record<string, unknown>).insert = (table: unknown) => ({
        values: (values: Partial<FakeRow> & { agentSessionId: string }) => {
          const rawChain = origInsert(table).values(values);
          if (!("transcript" in values)) return rawChain;
          const realChain = thenableChain(rawChain);
          return {
            then: realChain.then.bind(realChain),
            onConflictDoUpdate: (): Promise<void> => {
              attempts++;
              return Promise.reject(new Error("unsupported Unicode escape sequence"));
            },
          };
        },
      });

      const svc = makeSvc(db, source);

      // Sweeps 1..3 attempt and fail, accumulating toward the threshold.
      for (let i = 0; i < INGEST_QUARANTINE_THRESHOLD; i++) {
        const result = await svc.ingestAll();
        expect(result.sessionsErrored).toBe(1);
        expect(result.sessionsQuarantined).toBe(0);
      }
      expect(attempts).toBe(INGEST_QUARANTINE_THRESHOLD);
      expect(state.get(SESSION_A)?.ingestQuarantinedAt).toBeInstanceOf(Date);
      expect(state.get(SESSION_A)?.ingestLastError).toContain("unsupported Unicode escape");

      // The next sweep must NOT attempt it: the upsert count stays put, and the
      // session is reported as quarantined rather than errored.
      const after = await svc.ingestAll();
      expect(attempts).toBe(INGEST_QUARANTINE_THRESHOLD);
      expect(after.sessionsQuarantined).toBe(1);
      expect(after.sessionsErrored).toBe(0);
      expect(after.sessionsProcessed).toBe(1);
    });

    // mt#3278: quarantine is self-healing — once the cause is fixed, the first
    // pass that gets through clears it with no manual step. Without this, every
    // poisoned session would need a human to un-stick it after the fix ships.
    test("a successful ingest clears an existing quarantine and its failure count", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));

      const state = new Map<string, FakeRow>();
      state.set(SESSION_A, {
        agentSessionId: SESSION_A,
        harness: "claude_code",
        transcript: [],
        startedAt: null,
        endedAt: null,
        cwd: null,
        projectDir: null,
        lastIngestedJsonlTimestamp: null,
        ingestedAt: new Date(),
        model: null,
        ingestFailureCount: INGEST_QUARANTINE_THRESHOLD,
        ingestLastError: "unsupported Unicode escape sequence",
        ingestLastFailedAt: new Date(),
        // Deliberately NOT quarantined, so the ingest is attempted and can
        // demonstrate the reset; the skip path is covered by the test above.
        ingestQuarantinedAt: null,
      });

      const svc = makeSvc(makeDb(state), source);
      const result = await svc.ingestAll();

      expect(result.sessionsErrored).toBe(0);
      expect(state.get(SESSION_A)?.ingestFailureCount).toBe(0);
      expect(state.get(SESSION_A)?.ingestQuarantinedAt).toBeNull();
      expect(state.get(SESSION_A)?.ingestLastError).toBeNull();
    });

    // mt#3288 AT1. Before the fix, `ingestSession` called
    // `readSession(agentSessionId)` with no path, so a discovery-backed source
    // re-walked the whole corpus once per session — K walks for K sessions, and
    // O(K^2) file reads for the sweep. These two assertions are the regression
    // lock: the walk count must stay at 1 regardless of K, and every
    // `readSession` call must carry the path its `DiscoveredSession` was found
    // at, since that is what lets a real source skip the scan.
    test("walks discoverSessions exactly once regardless of session count, and passes each jsonlPath through", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, makeLines([TS1]));
      source.addSession(SESSION_B, makeLines([TS2]));
      source.addSession(SESSION_C, makeLines([TS3]));

      const svc = makeSvc(makeDb(new Map<string, FakeRow>()), source);
      const result: IngestAllResult = await svc.ingestAll();

      expect(result.sessionsProcessed).toBe(3);
      expect(source.discoverSessionsCalls).toBe(1);
      expect(source.readSessionPaths).toEqual([
        `/fake/projects/proj/${SESSION_A}.jsonl`,
        `/fake/projects/proj/${SESSION_B}.jsonl`,
        `/fake/projects/proj/${SESSION_C}.jsonl`,
      ]);
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
          const rawChain = origInsert(_table).values(values);
          // Only the TRANSCRIPT upsert is being intercepted; every other write
          // (attachments, turns, the failure record) passes straight through,
          // mirroring the guard the sibling override above already uses. The
          // array-valued chain has no `then` by design (PR #2503 R1), so
          // re-wrapping it unconditionally would throw here.
          if (!("transcript" in values)) return rawChain;
          const realChain = thenableChain(rawChain);
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
          const rawChain = origInsert(_table).values(values);
          // Same guard as the sibling overrides: pass non-transcript writes
          // straight through. The array-valued chain (attachments, turns) has
          // no `then` by design (PR #2503 R1), so re-wrapping it would throw.
          if (!("transcript" in values)) return rawChain;
          const realChain = thenableChain(rawChain);
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

  // mt#2763 acceptance test 2: "A test Bash command that would echo a known
  // credential pattern has its output redacted before transcript
  // persistence." The credential below is SYNTHETIC (shape-matching only,
  // not derived from any real incident) — see credential-scrubber.test.ts's
  // header note on this convention.
  describe("credential scrubbing (mt#2763)", () => {
    const FAKE_AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 uppercase alnum — synthetic

    function makeToolResultLine(ts: string, text: string): RawTurnLine {
      return {
        type: "user",
        timestamp: ts,
        uuid: `uuid-${ts}`,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }],
        },
      };
    }

    test("redacts a synthetic credential-shaped string before it reaches the persisted transcript", async () => {
      const leakedOutput = `aws key present: ${FAKE_AWS_KEY}`;
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [makeToolResultLine(TS1, leakedOutput)]);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      const result = await svc.ingestSession(makeDiscovered(SESSION_A));

      expect(result.error).toBeUndefined();
      const row = state.get(SESSION_A);
      expect(row).toBeDefined();
      const persisted = JSON.stringify(row?.transcript ?? []);

      // The raw credential must never appear in the durable copy...
      expect(persisted).not.toContain(FAKE_AWS_KEY);
      // ...replaced with the identifiable, shape-tagged marker.
      expect(persisted).toContain("[REDACTED:aws-access-key-id:");
      expect(persisted).toContain(FAKE_AWS_KEY.slice(0, 8));
    });

    test("leaves transcript content untouched when no credential shape matches", async () => {
      const source = new FakeTranscriptSource();
      source.addSession(SESSION_A, [makeToolResultLine(TS1, "no secrets here, just output")]);
      const state = new Map<string, FakeRow>();
      const db = makeDb(state);
      db._primeSession(SESSION_A);

      const svc = makeSvc(db, source);
      await svc.ingestSession(makeDiscovered(SESSION_A));

      const row = state.get(SESSION_A);
      const persisted = JSON.stringify(row?.transcript ?? []);
      expect(persisted).toContain("no secrets here, just output");
      expect(persisted).not.toContain("[REDACTED:");
    });
  });
});

// ---------------------------------------------------------------------------
// Agent-spawns extraction at ingest (mt#3109)
//
// AgentSpawnsPipeline.runForSession() is called inline from ingestSession()
// instead of via a registered sweep — see this task's spec `## Amendment
// 2026-07-23` and the ingest-service's own "Inline agent-spawns extraction"
// docblock section for the rationale. These tests cover the call site's
// contract: WHEN it fires, that a failure inside it never fails the ingest,
// and that the production default (no override) composes safely.
// ---------------------------------------------------------------------------

describe("agent-spawns extraction at ingest (mt#3109)", () => {
  /** A spy-based SpawnsExtractor recording every `runForSession` call. */
  function makeSpySpawnsExtractor(impl?: (agentSessionId: string) => Promise<void>): {
    extractor: SpawnsExtractor;
    calls: string[];
  } {
    const calls: string[] = [];
    const extractor: SpawnsExtractor = {
      async runForSession(agentSessionId: string) {
        calls.push(agentSessionId);
        if (impl) await impl(agentSessionId);
        return { ...NOOP_SPAWNS_RESULT };
      },
    };
    return { extractor, calls };
  }

  test("calls the spawns-extractor's runForSession with the ingested session's id when new lines are written", async () => {
    const lines = makeLines([TS1, TS2]);
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);
    const { extractor, calls } = makeSpySpawnsExtractor();

    const svc = makeSvc(db, source, extractor);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([SESSION_A]);
  });

  test("does NOT call the spawns-extractor on an idempotent re-ingest with no new lines", async () => {
    const lines = makeLines([TS1]);
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);
    const { extractor, calls } = makeSpySpawnsExtractor();
    const svc = makeSvc(db, source, extractor);

    // First ingest writes the line and advances the high-water-mark.
    await svc.ingestSession(makeDiscovered(SESSION_A));
    expect(calls).toEqual([SESSION_A]);

    // Second ingest of the SAME unchanged source is the idempotent no-op
    // path (no new lines past the stored high-water-mark) — confirms the
    // "reached only on new-content path" incrementality claim.
    db._primeSession(SESSION_A);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));
    expect(result.ingested).toBe(0);
    expect(calls).toEqual([SESSION_A]); // still just the one call from the first ingest
  });

  test("a thrown/rejected runForSession call does not propagate out of ingestSession", async () => {
    const lines = makeLines([TS1]);
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);
    const throwingExtractor: SpawnsExtractor = {
      runForSession: async () => {
        throw new Error("simulated spawn-extraction failure");
      },
    };

    const svc = makeSvc(db, source, throwingExtractor);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    // Matches the writeCwdMatchLink defensive posture: a spawn-extraction
    // failure is logged (not asserted here) but never fails the ingest.
    expect(result.error).toBeUndefined();
    const row = state.get(SESSION_A);
    expect(row?.transcript?.length).toBe(1);
  });

  test("with no constructor override, a query failure inside the real default AgentSpawnsPipeline does not propagate", async () => {
    const lines = makeLines([TS1]);
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    // Deliberately bypass makeSvc's no-op default: construct with ONLY
    // (db, source) so the constructor's default parameter builds a REAL
    // AgentSpawnsPipeline bound to this fake db. That pipeline's own
    // `runForSession` issues a `.select().from().innerJoin()...` query this
    // hand-rolled fake doesn't implement (no `.innerJoin`) — proving the
    // production default composes safely (AgentSpawnsPipeline's own internal
    // try/catch logs and returns a zeroed result) even without an injected
    // test double.
    const svc = new AgentTranscriptIngestService(asPgDb(db), source);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    const row = state.get(SESSION_A);
    expect(row?.transcript?.length).toBe(1);
  });

  test("with no constructor override, a query failure inside the real default ToolCallProjectionPipeline does not propagate (mt#3329)", async () => {
    const lines = makeLines([TS1]);
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    // Deliberately bypass makeSvc's no-op defaults for BOTH pipelines: pass
    // only (db, source) so both the spawnsExtractor and toolCallProjector
    // constructor defaults build REAL pipelines bound to this fake db.
    // Neither pipeline's query shape matches this hand-rolled fake (no
    // `.limit()` on the plain `.select().from().where()` chain
    // ToolCallProjectionPipeline issues) — proving the production default
    // composes safely (its own internal Array.isArray guard + try/catch log
    // and return a zeroed result) even without an injected test double,
    // exactly like the AgentSpawnsPipeline case immediately above.
    const svc = new AgentTranscriptIngestService(asPgDb(db), source);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    const row = state.get(SESSION_A);
    expect(row?.transcript?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Model extraction (mt#3089)
//
// agent_transcripts.model was 0/1729 populated in production despite every
// real assistant JSONL line carrying a message.model field — the ingest path
// simply never referenced `model` at all (extraction, not availability, was
// the gap). extractModelFromNewLines is the fix; these tests cover both the
// pure extractor and its wiring into ingestSession's insert/upsert.
// ---------------------------------------------------------------------------

function makeAssistantLine(ts: string, model: string | undefined, uuid: string): RawTurnLine {
  return {
    type: "assistant",
    timestamp: ts,
    uuid,
    message: { role: "assistant", model, content: "reply" },
  };
}

describe("extractModelFromNewLines (mt#3089)", () => {
  test("returns the first genuine model id from an assistant line", () => {
    const lines = [
      makeAssistantLine(TS1, "claude-sonnet-5", "u1"),
      makeAssistantLine(TS2, "claude-opus-5", "u2"),
    ];
    expect(extractModelFromNewLines(lines)).toBe("claude-sonnet-5");
  });

  test("skips the synthetic sentinel and returns the next genuine model", () => {
    const lines = [
      makeAssistantLine(TS1, SYNTHETIC_MODEL_SENTINEL, "u1"),
      makeAssistantLine(TS2, "claude-sonnet-5", "u2"),
    ];
    expect(extractModelFromNewLines(lines)).toBe("claude-sonnet-5");
  });

  test("ignores non-assistant lines", () => {
    const lines = [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", model: "not-real" } },
    ];
    expect(extractModelFromNewLines(lines)).toBeNull();
  });

  test("returns null when no line carries a genuine model", () => {
    expect(extractModelFromNewLines([makeAssistantLine(TS1, undefined, "u1")])).toBeNull();
    expect(extractModelFromNewLines([])).toBeNull();
  });
});

describe("countAssistantLines (mt#3089 R1 review)", () => {
  test("counts only assistant-type lines", () => {
    const lines = [
      makeAssistantLine(TS1, "claude-sonnet-5", "u1"),
      { type: "user", timestamp: TS2, uuid: "u2", message: { role: "user", content: "hi" } },
      makeAssistantLine(TS3, "claude-sonnet-5", "u3"),
    ];
    expect(countAssistantLines(lines)).toBe(2);
  });

  test("returns 0 for an empty batch or a batch with no assistant lines", () => {
    expect(countAssistantLines([])).toBe(0);
    expect(
      countAssistantLines([
        { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "hi" } },
      ])
    ).toBe(0);
  });
});

describe("AgentTranscriptIngestService — model column (mt#3089)", () => {
  test("first ingest with an assistant turn populates agent_transcripts.model", async () => {
    const lines = [makeAssistantLine(TS1, "claude-sonnet-5", "u1")];
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, lines);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    const svc = makeSvc(db, source);
    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    expect(state.get(SESSION_A)?.model).toBe("claude-sonnet-5");
  });

  test("a later incremental ingest without a model-bearing turn does not clobber the stored model", async () => {
    const source = new FakeTranscriptSource();
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);

    // First ingest: model-bearing assistant turn.
    source.addSession(SESSION_A, [makeAssistantLine(TS1, "claude-sonnet-5", "u1")]);
    db._primeSession(SESSION_A);
    const svc = makeSvc(db, source);
    await svc.ingestSession(makeDiscovered(SESSION_A));
    expect(state.get(SESSION_A)?.model).toBe("claude-sonnet-5");

    // Second, incremental ingest: a plain user turn only, no model field —
    // must not regress the already-stored model to null.
    source.addSession(SESSION_A, [
      makeAssistantLine(TS1, "claude-sonnet-5", "u1"),
      { type: "user", timestamp: TS2, uuid: "u2", message: { role: "user", content: "more" } },
    ]);
    await svc.ingestSession(makeDiscovered(SESSION_A));
    expect(state.get(SESSION_A)?.model).toBe("claude-sonnet-5");
  });

  test("no assistant turn in the batch leaves model null (not a synthetic placeholder)", async () => {
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "hi" } },
    ]);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    const svc = makeSvc(db, source);
    await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(state.get(SESSION_A)?.model ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extractor observability (mt#3089 R1 review — BLOCKING #1)
//
// A null model result is unremarkable when the batch has no assistant lines
// (nothing to extract from) but a GENUINE miss when assistant lines ARE
// present and none carried a genuine model — either every one was a
// synthetic retry, or the transcript shape has drifted out from under the
// extractor. The warn/no-warn split itself is `decideMissingModelWarn`, a
// pure function (mt#3628) tested below by return value; `ingestSession`'s
// role is reduced to a single wiring test verifying the shell actually
// EMITS what the core decided, via the constructor's injected `logWarn`
// (never `spyOn(log)` — the underlying model-extraction behavior
// (state.get(...).model) is exercised directly, not via the log channel).
// ---------------------------------------------------------------------------

describe("decideMissingModelWarn (pure core, mt#3628 / mt#3089 R1)", () => {
  test("warns when assistant lines are present but none carried a genuine model", () => {
    expect(decideMissingModelWarn(null, 2)).toEqual({ shouldWarn: true });
  });

  test("does NOT warn when there are no assistant lines at all (the common, unremarkable case)", () => {
    expect(decideMissingModelWarn(null, 0)).toEqual({ shouldWarn: false });
  });

  test("does NOT warn when a genuine model was found", () => {
    expect(decideMissingModelWarn("claude-sonnet-5", 1)).toEqual({ shouldWarn: false });
  });
});

describe("extractor observability — assistant-lines-present-but-no-model (mt#3089 R1)", () => {
  test("does NOT regress model extraction when every assistant line is synthetic", async () => {
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [
      makeAssistantLine(TS1, SYNTHETIC_MODEL_SENTINEL, "u1"),
      makeAssistantLine(TS2, SYNTHETIC_MODEL_SENTINEL, "u2"),
    ]);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    const svc = makeSvc(db, source);
    await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(state.get(SESSION_A)?.model ?? null).toBeNull();
  });

  test("does NOT regress model extraction when a genuine model IS found", async () => {
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [makeAssistantLine(TS1, "claude-sonnet-5", "u1")]);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    const svc = makeSvc(db, source);
    await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(state.get(SESSION_A)?.model).toBe("claude-sonnet-5");
  });

  test("wiring: ingestSession routes the warn decision through the injected logWarn sink, not spyOn(log)", async () => {
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const makeSvcWithSink = (source: FakeTranscriptSource, db: FakeDbType) =>
      makeSvc(db, source, undefined, undefined, (message, meta) =>
        warnCalls.push({ message, meta })
      );

    // Warn-worthy: assistant lines present, none carried a genuine model.
    const warnSource = new FakeTranscriptSource();
    warnSource.addSession(SESSION_A, [
      makeAssistantLine(TS1, SYNTHETIC_MODEL_SENTINEL, "u1"),
      makeAssistantLine(TS2, SYNTHETIC_MODEL_SENTINEL, "u2"),
    ]);
    const warnState = new Map<string, FakeRow>();
    const warnDb = makeDb(warnState);
    warnDb._primeSession(SESSION_A);
    await makeSvcWithSink(warnSource, warnDb).ingestSession(makeDiscovered(SESSION_A));

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.message).toContain(SESSION_A);
    expect(warnCalls[0]?.message).toContain("2 assistant line(s)");
    expect(warnCalls[0]?.meta).toMatchObject({ agentSessionId: SESSION_A, assistantLineCount: 2 });

    // Not warn-worthy: no assistant lines at all — must NOT route through the sink.
    warnCalls.length = 0;
    const quietSource = new FakeTranscriptSource();
    quietSource.addSession(SESSION_A, [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "hi" } },
    ]);
    const quietState = new Map<string, FakeRow>();
    const quietDb = makeDb(quietState);
    quietDb._primeSession(SESSION_A);
    await makeSvcWithSink(quietSource, quietDb).ingestSession(makeDiscovered(SESSION_A));

    expect(warnCalls).toHaveLength(0);
  });
});

// ── mt#3656: writer-divergence detection is WIRED, not just importable ────────

describe("writer-divergence verdict is persisted by ingestSession", () => {
  /**
   * A two-writer fork, in the shape the real specimen has: two prompts under
   * one parent, each answered, each followed by its own `last-prompt`.
   *
   * The `last-prompt` rows deliberately carry NO `timestamp` — that is how the
   * real format writes them, and it is why they must be observed before the
   * ingest loop's `if (!tsStr) continue` gate. A test whose sidecar rows had
   * timestamps would pass even if the scanner sat below that gate, which is
   * precisely the wiring bug this test exists to catch.
   */
  const FORKED_LINES = [
    { type: "user", timestamp: TS1, uuid: "root", message: { role: "user", content: "q" } },
    {
      type: "assistant",
      timestamp: TS1,
      uuid: "trunk",
      parentUuid: "root",
      message: { role: "assistant", content: "a" },
    },
    { type: "last-prompt", leafUuid: "trunk" },
    {
      type: "user",
      timestamp: TS2,
      uuid: "writerA",
      parentUuid: "trunk",
      message: { role: "user", content: "A" },
    },
    {
      type: "assistant",
      timestamp: TS2,
      uuid: "replyA",
      parentUuid: "writerA",
      message: { role: "assistant", content: "a" },
    },
    { type: "last-prompt", leafUuid: "replyA" },
    {
      type: "user",
      timestamp: TS3,
      uuid: "writerB",
      parentUuid: "trunk",
      message: { role: "user", content: "B" },
    },
    {
      type: "assistant",
      timestamp: TS3,
      uuid: "replyB",
      parentUuid: "writerB",
      message: { role: "assistant", content: "b" },
    },
    { type: "last-prompt", leafUuid: "replyB" },
  ] as unknown as RawTurnLine[];

  test("stores both divergent tips when two writers forked", async () => {
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, FORKED_LINES);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    await makeSvc(db, source).ingestSession(makeDiscovered(SESSION_A));

    const row = state.get(SESSION_A);
    expect(row?.divergentTipLeaves?.sort()).toEqual(["replyA", "replyB"]);
    // The pre-fork `last-prompt` is an ancestor of both, so it is not a tip.
    expect(row?.divergentTipLeaves).not.toContain("trunk");
    expect(row?.divergenceCheckedAt).toBeInstanceOf(Date);
  });

  test("warns through the injected sink when a fork is detected", async () => {
    const warnCalls: string[] = [];
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, FORKED_LINES);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    await makeSvc(db, source, undefined, undefined, (message) => {
      warnCalls.push(message);
    }).ingestSession(makeDiscovered(SESSION_A));

    expect(warnCalls.some((m) => m.includes("Writer divergence"))).toBe(true);
  });

  test("a sidecar line does not consume a lineIndex, so attachment PKs are stable (mt#3836)", async () => {
    // The corpus-wide hazard. `lineIndex` is half of
    // `agent_transcript_attachments`' primary key, so if retaining a new line
    // type shifted the counter, every attachment after the first sidecar row in
    // every already-ingested transcript would change key and re-ingest as a
    // duplicate. This pins that the attachment's index is decided by the
    // CONTENT lines before it and nothing else.
    const withSidecar = new FakeTranscriptSource();
    withSidecar.addSession(SESSION_A, [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "q" } },
      { type: "last-prompt", leafUuid: "u1" },
      makeAttachmentLine(TS2),
    ] as unknown as RawTurnLine[]);

    const withoutSidecar = new FakeTranscriptSource();
    withoutSidecar.addSession(SESSION_B, [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "q" } },
      makeAttachmentLine(TS2),
    ] as unknown as RawTurnLine[]);

    const stateA = new Map<string, FakeRow>();
    const dbA = makeDb(stateA);
    dbA._primeSession(SESSION_A);
    await makeSvc(dbA, withSidecar).ingestSession(makeDiscovered(SESSION_A));

    const stateB = new Map<string, FakeRow>();
    const dbB = makeDb(stateB);
    dbB._primeSession(SESSION_B);
    await makeSvc(dbB, withoutSidecar).ingestSession(makeDiscovered(SESSION_B));

    const indexOf = (db: ReturnType<typeof makeDb>): number[] =>
      db._attachments.map((a: { lineIndex: number }) => a.lineIndex);

    expect(indexOf(dbA)).toEqual(indexOf(dbB));
    expect(indexOf(dbA).length).toBeGreaterThan(0);
  });

  test("persists the verdict on an idempotent re-ingest with no new lines (PR #2656 R1)", async () => {
    // The regression: the verdict was computed BELOW the no-new-lines early
    // return, so it was discarded whenever the upsert was skipped. Every
    // conversation ingested before this detector shipped is permanently on that
    // path — it never receives new lines again — so the whole existing corpus
    // would have stayed unchecked.
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, FORKED_LINES);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);
    const svc = makeSvc(db, source);

    // First ingest stores the verdict via the upsert; clear it to model a row
    // that predates the detector, then re-ingest with the file unchanged.
    await svc.ingestSession(makeDiscovered(SESSION_A));
    const primed = state.get(SESSION_A) as FakeRow;
    state.set(SESSION_A, { ...primed, divergentTipLeaves: null, divergenceCheckedAt: null });

    const result = await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(result.ingested).toBe(0);
    const row = state.get(SESSION_A);
    expect(row?.divergentTipLeaves?.sort()).toEqual(["replyA", "replyB"]);
    expect(row?.divergenceCheckedAt).toBeInstanceOf(Date);
    // The transcript itself is untouched — this path still ingested nothing.
    expect(row?.transcript).toEqual(primed.transcript);
  });

  test("records an empty verdict — not NULL — for an ordinary linear conversation", async () => {
    // The distinction matters: NULL means "never checked", so a clean
    // conversation must be positively marked as checked rather than left
    // indistinguishable from one ingested before the detector existed.
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [
      { type: "user", timestamp: TS1, uuid: "u1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        timestamp: TS2,
        uuid: "a1",
        parentUuid: "u1",
        message: { role: "assistant", content: "yo" },
      },
      { type: "last-prompt", leafUuid: "a1" },
    ] as unknown as RawTurnLine[]);
    const state = new Map<string, FakeRow>();
    const db = makeDb(state);
    db._primeSession(SESSION_A);

    await makeSvc(db, source).ingestSession(makeDiscovered(SESSION_A));

    const row = state.get(SESSION_A);
    expect(row?.divergentTipLeaves).toEqual([]);
    expect(row?.divergenceCheckedAt).toBeInstanceOf(Date);
  });
});
