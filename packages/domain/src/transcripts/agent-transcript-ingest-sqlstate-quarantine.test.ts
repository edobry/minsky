/**
 * A server-side SQLSTATE must not advance the per-session quarantine counter
 * (mt#4519).
 *
 * Split out of `agent-transcript-ingest-service.test.ts` rather than added to
 * it, for the reason its sibling `agent-transcript-ingest-abort.test.ts`
 * already records: that file sits within ~20 lines of the 1500-line `max-lines`
 * ceiling, and these tests need none of its ~600-line fake-database harness.
 * Every case here fails at the high-water-mark read — the FIRST query each
 * session issues — so a fake that rejects on read and records whether a write
 * was attempted is sufficient.
 *
 * ## What this file covers, and what it deliberately does not
 *
 * The DECISION — which SQLSTATE classes count as a condition at the database —
 * is a pure function, `databaseConditionSqlStateClass`, and is covered per class
 * in `persistence/connection-failure.test.ts` (classes 08/40/53/57, plus the
 * client-side codes and class-42 it must reject, plus the cause chain). Testing
 * all of that again through the service would be the same assertions at a worse
 * altitude.
 *
 * What can ONLY be checked here is the WIRING: that `recordIngestFailure`
 * actually consults the predicate. That is the half that was broken — the
 * predicate did not exist, so the counter treated every server-side SQLSTATE as
 * a verdict about the conversation's own content.
 *
 * ## The observable
 *
 * `recordIngestFailure` returns BEFORE writing when the failure is not the
 * session's fault, so "was an upsert attempted at all" is the discriminator —
 * no counter arithmetic, and no need to model the quarantine upsert faithfully.
 *
 * ## Measured origin (mt#4500, 2026-08-24)
 *
 * Three real conversations sat quarantined on `57014 query_canceled`, written
 * during an 11.5-minute degraded-database window on 2026-08-19. All three
 * ingested cleanly on release with no code change — 645, 457 and 123 new lines
 * — so the transcripts were healthy the whole time and the quarantine was
 * entirely an artifact of this classification gap.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ConversationId } from "../ids";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { AgentTranscriptIngestService } from "./agent-transcript-ingest-service";

const HARNESS = "claude_code";
const SESSION_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const TS1 = "2026-01-01T10:00:00.000Z";

/** Minimal source: one session carrying one ordinary user line. */
class StubSource implements TranscriptSource {
  readonly harness = HARNESS;

  async *discoverSessions(): AsyncIterable<DiscoveredSession> {
    yield {
      agentSessionId: SESSION_ID as ConversationId,
      jsonlPath: `/nonexistent/${SESSION_ID}.jsonl`,
      harness: HARNESS,
      isSubagent: false,
      mtime: new Date("2026-01-01T00:00:00.000Z"),
    };
  }

  async *readSession(): AsyncIterable<RawTurnLine> {
    yield {
      type: "user",
      uuid: "u-1",
      timestamp: TS1,
      message: { role: "user", content: [] },
    } as unknown as RawTurnLine;
  }

  getJsonlTimestamp(line: RawTurnLine): string | undefined {
    return typeof line.timestamp === "string" ? line.timestamp : undefined;
  }
}

/**
 * A database that fails the TRANSCRIPT upsert with `code` and records whether a
 * failure-record write followed.
 *
 * The failure must land on the upsert specifically: `recordIngestFailure` is
 * reached from the three WRITE paths, never from the high-water-mark read, so a
 * read-rejecting fake (the shape `agent-transcript-ingest-abort.test.ts` uses)
 * would exercise a different branch entirely. Found by running this test, not by
 * reading the code.
 *
 * The two upserts are told apart the same way the main harness tells them apart:
 * the failure record carries `ingestFailureCount` and no `transcript`.
 */
function makeDb(code: string): { db: PostgresJsDatabase; writes: string[] } {
  const writes: string[] = [];
  const failure = () => Promise.reject(Object.assign(new Error(`carrying ${code}`), { code }));
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const isTranscriptUpsert = "transcript" in values;
        return {
          onConflictDoUpdate: () => {
            if (isTranscriptUpsert) return failure();
            writes.push(String(values["ingestLastError"] ?? code));
            return Promise.resolve();
          },
          onConflictDoNothing: () => Promise.resolve(),
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as PostgresJsDatabase;
  return { db, writes };
}

async function sweepOnce(code: string): Promise<string[]> {
  const { db, writes } = makeDb(code);
  await new AgentTranscriptIngestService(db, new StubSource()).ingestAll();
  return writes;
}

describe("server-side SQLSTATEs do not count toward quarantine (mt#4519)", () => {
  // AT1. `57014` query_canceled is a statement timeout: the DATABASE cancelled
  // the statement under load. That is no more a fact about this conversation
  // than a `CONNECTION_ENDED` is — the argument mt#4480 already made for
  // client-side connection codes, applied to the code space it could not see.
  test("a statement timeout records no failure against the session", async () => {
    expect(await sweepOnce("57014")).toHaveLength(0);
  });

  // The same for a connection-level SQLSTATE. Worth its own case because it is
  // the one that shows the gap was never specific to timeouts: `08006` is
  // literally `connection_failure`, and it reached the counter identically.
  test("a server-reported connection failure records nothing either", async () => {
    expect(await sweepOnce("08006")).toHaveLength(0);
  });

  // AT3 — the guard must not become "never quarantine anything". `22021` is the
  // text-column shape of the mt#3278 NUL defect this mechanism was BUILT for
  // (mem#750), and class 22 sits deliberately outside the DB-condition classes.
  test("a content fault Postgres cannot represent still counts", async () => {
    expect(await sweepOnce("22021")).toHaveLength(1);
  });

  // A malformed query is a bug in OUR code, not a condition at the database —
  // the same boundary mt#4100 drew for the daemon's exit path. If class 42 were
  // swallowed here it would look like an infrastructure blip forever.
  test("a class-42 syntax error still counts", async () => {
    expect(await sweepOnce("42601")).toHaveLength(1);
  });
});
