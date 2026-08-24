/**
 * `ingestAll` abandons a pass whose database connection has died (mt#4480).
 *
 * Split out of `agent-transcript-ingest-service.test.ts` rather than added to
 * it: that file sits within a few dozen lines of the 1500-line `max-lines`
 * ceiling, and these tests need none of its ~300-line fake-database harness.
 * Every case here fails at the high-water-mark read — the FIRST query each
 * session issues — so a fake that can only reject is sufficient, and a
 * purpose-built one states the setup in four lines instead of hiding it in a
 * shared fixture.
 *
 * Negative control on record: before this shipped, production sweep passes ran
 * to completion reporting `sessionsProcessed: 1502, sessionsErrored: 1502,
 * totalIngested: 0` — every session failing instantly against a pool the
 * cockpit's own recycler had torn down mid-pass. Nothing in any counter a
 * caller reads distinguished those passes from healthy ones.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ConversationId } from "../ids";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { AgentTranscriptIngestService } from "./agent-transcript-ingest-service";
import type { IngestAllResult } from "./agent-transcript-ingest-service";

const HARNESS = "claude_code";
const conv = (id: string) => id as ConversationId;

/** Minimal source: yields N sessions, each with one line. */
class StubSource implements TranscriptSource {
  readonly harness = HARNESS;
  private readonly sessions: DiscoveredSession[] = [];

  add(id: string): void {
    this.sessions.push({
      agentSessionId: conv(id),
      jsonlPath: `/nonexistent/${id}.jsonl`,
      harness: HARNESS,
      isSubagent: false,
      mtime: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  async *discoverSessions(): AsyncIterable<DiscoveredSession> {
    for (const s of this.sessions) yield s;
  }

  async *readSession(): AsyncIterable<RawTurnLine> {
    // Never reached: every session in this file aborts at the HWM read.
  }

  getJsonlTimestamp(line: RawTurnLine): string | undefined {
    return typeof line.timestamp === "string" ? line.timestamp : undefined;
  }
}

/** An error shaped like the one postgres-js raises on a dead socket. */
function connectionEndedError(): Error {
  const err = new Error("write CONNECTION_ENDED pooler.example.com:6543");
  (err as Error & { code: string }).code = "CONNECTION_ENDED";
  return err;
}

/**
 * A database whose high-water-mark read rejects with whatever `errorFor`
 * returns for that call index (1-based), letting a test interleave failure
 * kinds across sessions.
 */
function makeFailingDb(errorFor: (call: number) => Error): PostgresJsDatabase {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            call++;
            return Promise.reject(errorFor(call));
          },
        }),
      }),
    }),
  } as unknown as PostgresJsDatabase;
}

function makeSource(count: number): StubSource {
  const source = new StubSource();
  for (let i = 0; i < count; i++) {
    source.add(`0000000${i}-0000-0000-0000-00000000000${i}`);
  }
  return source;
}

describe("ingestAll abandons a pass on consecutive connection failures (mt#4480)", () => {
  test("aborts once the threshold of consecutive infra failures is hit", async () => {
    const svc = new AgentTranscriptIngestService(
      makeFailingDb(() => connectionEndedError()),
      makeSource(5)
    );

    const result: IngestAllResult = await svc.ingestAll({
      abortAfterConsecutiveInfraFailures: 2,
    });

    // Stopped AT the threshold rather than walking the remaining sessions.
    expect(result.sessionsProcessed).toBe(2);
    expect(result.aborted).toBeDefined();
    expect(result.aborted?.consecutiveInfraFailures).toBe(2);
    expect(result.aborted?.failureKind).toBe("connection-lost");
    expect(result.aborted?.afterSessionsProcessed).toBe(2);
  });

  test("does NOT abort on failures it cannot classify as infrastructure", async () => {
    // The discriminator that keeps this from firing on ordinary per-session
    // errors. `classifyConnectionFailure` returns "unknown" for a code-less
    // error, and "unknown" must never count — otherwise a few bad transcripts
    // in a row would abandon a pass over 1,500 good ones.
    const svc = new AgentTranscriptIngestService(
      makeFailingDb(() => new Error("some per-session parse failure")),
      makeSource(4)
    );

    const result: IngestAllResult = await svc.ingestAll({
      abortAfterConsecutiveInfraFailures: 2,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.sessionsProcessed).toBe(4);
    expect(result.sessionsErrored).toBe(4);
  });

  test("a non-infrastructure outcome resets the consecutive run", async () => {
    // CONSECUTIVE, not cumulative: a connection that fails, works, and fails
    // again is flapping rather than gone, and the pass should keep going.
    // Sessions 1 and 3 die on the connection; session 2 fails for its own
    // reasons, which is evidence the connection is alive.
    const svc = new AgentTranscriptIngestService(
      makeFailingDb((call) =>
        call === 2 ? new Error("per-session failure") : connectionEndedError()
      ),
      makeSource(3)
    );

    const result: IngestAllResult = await svc.ingestAll({
      abortAfterConsecutiveInfraFailures: 2,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.sessionsProcessed).toBe(3);
    expect(result.sessionsErrored).toBe(3);
  });

  test("an empty sweep carries no abort marker", async () => {
    const svc = new AgentTranscriptIngestService(
      makeFailingDb(() => connectionEndedError()),
      makeSource(0)
    );

    const result: IngestAllResult = await svc.ingestAll({
      abortAfterConsecutiveInfraFailures: 2,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.sessionsProcessed).toBe(0);
  });
});
