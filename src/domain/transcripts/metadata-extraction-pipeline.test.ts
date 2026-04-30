/**
 * Tests for MetadataExtractionPipeline.
 *
 * Uses in-memory fakes for the DB — no real Postgres access.
 * Tests cover:
 *  - Extraction runs over all agent_transcripts rows
 *  - related_task_ids and related_pr_numbers columns populated correctly
 *  - Idempotency: re-running produces consistent results
 *  - Empty/null transcripts are skipped (columns left as-is)
 *  - Individual row errors do not abort the sweep
 *  - Error count accurately reflects failures
 *
 * @see mt#1329 — metadata-extraction-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import type { RawTurnLine } from "./transcript-source";
import { MetadataExtractionPipeline } from "./metadata-extraction-pipeline";
import type { ExtractionPipelineResult } from "./metadata-extraction-pipeline";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
const TS3 = "2026-01-01T12:00:00.000Z";
const TS4 = "2026-01-01T13:00:00.000Z";

// ── Fake DB row type ──────────────────────────────────────────────────────────

interface FakeTranscriptRow {
  agentSessionId: string;
  transcript: RawTurnLine[] | null;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
}

// ── Fake DB ───────────────────────────────────────────────────────────────────

/**
 * Creates a minimal fake DB that mimics drizzle's fluent builder surface for
 * the MetadataExtractionPipeline's queries:
 *   (1) select { agentSessionId, transcript } from agent_transcripts
 *   (2) update agent_transcripts set { relatedTaskIds, relatedPrNumbers } where agentSessionId = X
 *
 * Uses an ordering heuristic: updates happen in the same order as the
 * select result, which is insertion order from the Map.
 */
function makeSmartDb(store: Map<string, FakeTranscriptRow>, opts: { failUpdate?: boolean } = {}) {
  let updateIndex = 0;

  const db = {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => {
          // Reset update index on each full scan.
          updateIndex = 0;
          return Promise.resolve(
            Array.from(store.values()).map((r) => ({
              agentSessionId: r.agentSessionId,
              transcript: r.transcript,
            }))
          );
        },
      };
    },

    update(_table: unknown) {
      return {
        set(updates: Partial<FakeTranscriptRow>) {
          return {
            where(_cond: unknown): Promise<void> {
              if (opts.failUpdate) {
                return Promise.reject(new Error("Simulated update failure"));
              }
              const sessions = Array.from(store.keys());
              const sid = sessions[updateIndex];
              updateIndex++;
              if (sid) {
                const existing = store.get(sid);
                if (existing) {
                  store.set(sid, { ...existing, ...updates });
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

// ── Transcript fixtures ───────────────────────────────────────────────────────

function userLine(text: string, ts = TS1): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

function assistantLine(text: string, ts = TS2): RawTurnLine {
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function makeSvc(db: ReturnType<typeof makeSmartDb>): MetadataExtractionPipeline {
  return new MetadataExtractionPipeline(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MetadataExtractionPipeline", () => {
  describe("basic extraction", () => {
    test("extracts task IDs and PR numbers from transcript content", async () => {
      const transcript: RawTurnLine[] = [
        userLine("implement feature from mt#1313 spec", TS1),
        assistantLine("see PR #763 for the implementation", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result: ExtractionPipelineResult = await svc.run();

      expect(result.rowsScanned).toBe(1);
      expect(result.rowsUpdated).toBe(1);
      expect(result.rowsSkipped).toBe(0);
      expect(result.rowsErrored).toBe(0);

      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toContain("mt#1313");
      expect(row?.relatedPrNumbers).toContain("763");
    });

    test("spec acceptance criterion: mt#1313 + #763 → correct columns", async () => {
      const transcript: RawTurnLine[] = [userLine("mt#1313", TS1), assistantLine("#763", TS2)];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      await svc.run();

      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toEqual(["mt#1313"]);
      expect(row?.relatedPrNumbers).toEqual(["763"]);
    });

    test("populates empty arrays when no task IDs or PR numbers found", async () => {
      const transcript: RawTurnLine[] = [
        userLine("no references here", TS1),
        assistantLine("nothing to report", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      await svc.run();

      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toEqual([]);
      expect(row?.relatedPrNumbers).toEqual([]);
    });

    test("deduplicates task IDs and PR numbers across turns", async () => {
      const transcript: RawTurnLine[] = [
        userLine("work on mt#1313 and mt#1313 again", TS1),
        assistantLine("PR #100 and PR #100 done", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      await svc.run();

      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toHaveLength(1);
      expect(row?.relatedTaskIds?.[0]).toBe("mt#1313");
      expect(row?.relatedPrNumbers).toHaveLength(1);
      expect(row?.relatedPrNumbers?.[0]).toBe("100");
    });

    test("mt#X does not contribute to related_pr_numbers", async () => {
      const transcript: RawTurnLine[] = [
        userLine("mt#1313 is the parent task", TS1),
        assistantLine("see #50 for the PR", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      await svc.run();

      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toContain("mt#1313");
      expect(row?.relatedPrNumbers).toContain("50");
      expect(row?.relatedPrNumbers).not.toContain("1313");
    });
  });

  describe("idempotency", () => {
    test("re-running produces the same result (UPDATE always)", async () => {
      const transcript: RawTurnLine[] = [
        userLine("mt#42 was implemented", TS1),
        assistantLine("via PR #10", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      await svc.run();
      // Capture first-run values with explicit narrowing (avoids Partial<> spread issue).
      const afterFirstRun = store.get(SESSION_A);
      const firstTaskIds: string[] | null = afterFirstRun?.relatedTaskIds ?? null;
      const firstPrNumbers: string[] | null = afterFirstRun?.relatedPrNumbers ?? null;

      await svc.run();
      const secondRun = store.get(SESSION_A);

      expect(secondRun?.relatedTaskIds).toEqual(firstTaskIds);
      expect(secondRun?.relatedPrNumbers).toEqual(firstPrNumbers);
    });
  });

  describe("empty/null transcript handling", () => {
    test("empty transcript is skipped", async () => {
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript: [],
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsScanned).toBe(1);
      expect(result.rowsSkipped).toBe(1);
      expect(result.rowsUpdated).toBe(0);

      // Columns left as-is (not overwritten to empty arrays).
      const row = store.get(SESSION_A);
      expect(row?.relatedTaskIds).toBeNull();
    });

    test("null transcript is skipped", async () => {
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript: null,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsSkipped).toBe(1);
      expect(result.rowsUpdated).toBe(0);
    });
  });

  describe("error handling", () => {
    test("update failure increments rowsErrored and continues sweep", async () => {
      const transcript: RawTurnLine[] = [userLine("mt#100", TS1), assistantLine("done", TS2)];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });
      store.set(SESSION_B, {
        agentSessionId: SESSION_B,
        transcript,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      // Fail updates for all rows.
      const db = makeSmartDb(store, { failUpdate: true });
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsScanned).toBe(2);
      expect(result.rowsErrored).toBe(2);
      expect(result.rowsUpdated).toBe(0);
    });

    test("sweep over empty store returns zero counts", async () => {
      const store = new Map<string, FakeTranscriptRow>();
      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsScanned).toBe(0);
      expect(result.rowsUpdated).toBe(0);
      expect(result.rowsSkipped).toBe(0);
      expect(result.rowsErrored).toBe(0);
    });

    test("multiple rows: one skipped one updated", async () => {
      const transcript: RawTurnLine[] = [
        userLine("mt#200", TS1),
        assistantLine("done via #30", TS2),
      ];
      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript: null, // skipped
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });
      store.set(SESSION_B, {
        agentSessionId: SESSION_B,
        transcript, // processed
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsScanned).toBe(2);
      expect(result.rowsSkipped).toBe(1);
      expect(result.rowsUpdated).toBe(1);
      expect(result.rowsErrored).toBe(0);
    });
  });

  describe("multi-session sweep", () => {
    test("extracts from all sessions and returns correct totals", async () => {
      const transcriptA: RawTurnLine[] = [
        userLine("mt#1313 parent task", TS1),
        assistantLine("implementing PR #800", TS2),
      ];
      const transcriptB: RawTurnLine[] = [
        userLine("working on mt#1329", TS3),
        assistantLine("see PR #847", TS4),
      ];

      const store = new Map<string, FakeTranscriptRow>();
      store.set(SESSION_A, {
        agentSessionId: SESSION_A,
        transcript: transcriptA,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });
      store.set(SESSION_B, {
        agentSessionId: SESSION_B,
        transcript: transcriptB,
        relatedTaskIds: null,
        relatedPrNumbers: null,
      });

      const db = makeSmartDb(store);
      const svc = makeSvc(db);

      const result = await svc.run();

      expect(result.rowsScanned).toBe(2);
      expect(result.rowsUpdated).toBe(2);

      const rowA = store.get(SESSION_A);
      expect(rowA?.relatedTaskIds).toContain("mt#1313");
      expect(rowA?.relatedPrNumbers).toContain("800");

      const rowB = store.get(SESSION_B);
      expect(rowB?.relatedTaskIds).toContain("mt#1329");
      expect(rowB?.relatedPrNumbers).toContain("847");
    });
  });
});
