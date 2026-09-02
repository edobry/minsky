/**
 * Unit tests for the messages widget (mt#4874).
 *
 * Two layers, deliberately split:
 *
 * - `readSendMessageBlocks` is exercised directly against fabricated
 *   `tool_calls` jsonb. That column is an UNDOCUMENTED harness shape, so its
 *   reader has to fail open per field, and the cases that matter are the
 *   malformed ones.
 * - `fetch()` is exercised against a fake db routed by table identity, the
 *   pattern `driven-session-cost.test.ts` established. This covers the parts
 *   that are genuinely this widget's own logic rather than drizzle's: the
 *   pair-narrowing after the cross-product `IN`, the coverage accounting, and
 *   project scoping.
 *
 * The correlation rules themselves are NOT re-tested here — they live in
 * `@minsky/domain/transcripts/peer-message-correlation` and have their own
 * suite. Re-asserting them through a db fake would test the fake.
 */
import { describe, test, expect } from "bun:test";
import {
  createMessagesWidget,
  readSendMessageBlocks,
  SENDER_SCAN_LIMIT,
  type MessagesDb,
  type MessagesPayload,
} from "./messages";
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentToolCallProjectionTable } from "@minsky/domain/storage/schemas/agent-tool-call-projection-schema";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { transcriptLinesTable } from "@minsky/domain/storage/schemas/transcript-lines-schema";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import type { WidgetContext } from "../types";

// ---------------------------------------------------------------------------
// readSendMessageBlocks
// ---------------------------------------------------------------------------

describe("readSendMessageBlocks", () => {
  test("reads a SendMessage block, taking the recipient from `to`", () => {
    const blocks = readSendMessageBlocks([
      { name: "SendMessage", input: { to: "agent-7", message: "hello" } },
    ]);
    expect(blocks).toEqual([{ ordinal: 0, recipient: "agent-7", message: "hello" }]);
  });

  test("falls back to `recipient` when `to` is absent", () => {
    const blocks = readSendMessageBlocks([
      { name: "SendMessage", input: { recipient: "minsky-64", message: "hi" } },
    ]);
    expect(blocks[0]?.recipient).toBe("minsky-64");
  });

  test("ordinal is the position in the array, so two sends in one turn stay distinct", () => {
    const blocks = readSendMessageBlocks([
      { name: "Bash", input: { command: "ls" } },
      { name: "SendMessage", input: { to: "a", message: "same text" } },
      { name: "SendMessage", input: { to: "b", message: "same text" } },
    ]);
    expect(blocks.map((b) => b.ordinal)).toEqual([1, 2]);
    expect(blocks.map((b) => b.recipient)).toEqual(["a", "b"]);
  });

  test("a send with no readable message is RETAINED, not dropped", () => {
    // Production carries one such block. A send that happened is a fact about
    // the world even when its payload cannot be read; dropping it would
    // under-report the sender side.
    const blocks = readSendMessageBlocks([{ name: "SendMessage", input: { to: "a" } }]);
    expect(blocks).toEqual([{ ordinal: 0, recipient: "a", message: null }]);
  });

  test("non-array, null, and malformed entries yield [] or are skipped — never a throw", () => {
    expect(readSendMessageBlocks(null)).toEqual([]);
    expect(readSendMessageBlocks(undefined)).toEqual([]);
    expect(readSendMessageBlocks({ name: "SendMessage" })).toEqual([]);
    expect(readSendMessageBlocks("SendMessage")).toEqual([]);
    expect(readSendMessageBlocks([null, 42, "x", { name: "Other" }])).toEqual([]);
    expect(readSendMessageBlocks([{ name: "SendMessage", input: null }])).toEqual([
      { ordinal: 0, recipient: null, message: null },
    ]);
  });

  test("an empty-string message reads as null rather than as an empty send", () => {
    const blocks = readSendMessageBlocks([
      { name: "SendMessage", input: { to: "a", message: "   " } },
    ]);
    expect(blocks[0]?.message).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetch()
// ---------------------------------------------------------------------------

const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_A_SLUG = "edobry/minsky";
const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const BODY = "please pick up mt#4874";
const SENT_AT = "2026-09-01T12:00:00.000Z";
const SENT_END = "2026-09-01T12:00:10.000Z";
const RECEIVED_AT = "2026-09-01T12:00:12.000Z";

interface Fixture {
  sendRefs?: Array<{ agentSessionId: string; turnIndex: number }>;
  turns?: Array<{
    agentSessionId: string;
    turnIndex: number;
    toolCalls: unknown;
    startedAt: string | null;
    endedAt: string | null;
  }>;
  peerTurns?: Array<{ agentSessionId: string; turnIndex: number }>;
  lines?: Array<{ agentSessionId: string; lineOrdinal: number; line: unknown }>;
  transcripts?: Array<{ agentSessionId: string; projectId: string | null }>;
}

/**
 * Fake db routed by table identity, and — for the two reads that both hit
 * `agent_transcript_turns` — by whether the caller selected `toolCalls`. That
 * field discriminator is what keeps the peer-turn lookup and the send-payload
 * fetch apart without relying on call order.
 */
function makeDb(fixture: Fixture): MessagesDb {
  const promiseWithChain = (rows: unknown[]) => {
    const chain = {
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (...args: Parameters<Promise<unknown[]>["then"]>) =>
        Promise.resolve(rows).then(...args),
    };
    return chain;
  };

  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === agentToolCallProjectionTable) {
          return { where: () => promiseWithChain(fixture.sendRefs ?? []) };
        }
        if (table === agentTranscriptsTable) {
          return { where: () => Promise.resolve(fixture.transcripts ?? []) };
        }
        if (table === transcriptLinesTable) {
          return { where: () => Promise.resolve(fixture.lines ?? []) };
        }
        if (table === agentTranscriptTurnsTable) {
          const wantsPayload = fields !== undefined && "toolCalls" in fields;
          return {
            where: () =>
              Promise.resolve(wantsPayload ? (fixture.turns ?? []) : (fixture.peerTurns ?? [])),
          };
        }
        throw new Error("makeDb: unexpected table in .from()");
      },
    }),
  };
}

function makeScopeResolverDb(rows: Array<{ id: string; slug: string }>): ScopeResolverDb {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  } as ScopeResolverDb;
}

const ctx = (project?: string): WidgetContext =>
  ({ id: "messages", ...(project === undefined ? {} : { query: { project } }) }) as WidgetContext;

function peerLine(overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    timestamp: RECEIVED_AT,
    origin: {
      kind: "peer",
      from: "uds:/tmp/cc-socks/16603.sock",
      verifiedPeerPid: 16603,
      msg_id: "e4f53555-0000-4000-8000-000000000000",
      name: "minsky-64",
      fromMode: "prompting",
      body: BODY,
      ...((overrides["origin"] as Record<string, unknown>) ?? {}),
    },
  };
}

/** One send and its matching delivery, in two different sessions of project A. */
function pairedFixture(): Fixture {
  return {
    sendRefs: [{ agentSessionId: "sender", turnIndex: 7 }],
    turns: [
      {
        agentSessionId: "sender",
        turnIndex: 7,
        toolCalls: [{ name: "SendMessage", input: { to: "agent-7", message: BODY } }],
        startedAt: SENT_AT,
        endedAt: SENT_END,
      },
    ],
    peerTurns: [{ agentSessionId: "receiver", turnIndex: 3 }],
    lines: [{ agentSessionId: "receiver", lineOrdinal: 412, line: peerLine() }],
    transcripts: [
      { agentSessionId: "sender", projectId: PROJECT_A_ID },
      { agentSessionId: "receiver", projectId: PROJECT_A_ID },
    ],
  };
}

async function payloadOf(db: MessagesDb, project?: string, scopeDb?: ScopeResolverDb) {
  const widget = createMessagesWidget(
    async () => db,
    scopeDb === undefined ? undefined : async () => scopeDb
  );
  const result = await widget.fetch(ctx(project));
  expect(result.state).toBe("ok");
  if (result.state !== "ok") throw new Error(`degraded: ${result.reason}`);
  return result.payload as MessagesPayload;
}

describe("messagesWidget — contract", () => {
  test("id and updateMode match the widget-registry contract", () => {
    const widget = createMessagesWidget(async () => null);
    expect(widget.id).toBe("messages");
    expect(widget.updateMode).toEqual({ type: "polling", intervalMs: 60_000 });
  });

  test("no DB connection degrades explicitly — never an empty feed", async () => {
    const widget = createMessagesWidget(async () => null);
    const result = await widget.fetch(ctx());
    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    expect(result.reason).toBe("DB not connected");
  });

  test("a throwing query degrades the WHOLE widget rather than rendering a zero", async () => {
    const widget = createMessagesWidget(async () => ({
      select: () => {
        throw new Error("connection reset");
      },
    }));
    const result = await widget.fetch(ctx());
    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    expect(result.reason).toContain("connection reset");
  });
});

describe("messagesWidget — the feed", () => {
  test("an empty corpus is 'no-data' WITH coverage, so the page can state its limits", async () => {
    const payload = await payloadOf(makeDb({}));
    expect(payload.status).toBe("no-data");
    expect(payload.coverage.peerTurns).toBe(0);
    expect(payload.coverage.senderScanLimit).toBe(SENDER_SCAN_LIMIT);
    expect(payload.coverage.senderScanTruncated).toBe(false);
  });

  test("a send and its delivery come back correlated, one entry each", async () => {
    const payload = await payloadOf(makeDb(pairedFixture()));
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;

    expect(payload.feed.counts).toMatchObject({
      sent: 1,
      received: 1,
      paired: 2,
      ambiguous: 0,
      sentUnmatched: 0,
      receivedUnmatched: 0,
    });
    const received = payload.feed.entries.find((e) => e.direction === "received");
    expect(received?.origin?.fromKind).toBe("session");
    expect(received?.origin?.peerPid).toBe(16603);
    const sentEntry = payload.feed.entries.find((e) => e.direction === "sent");
    expect(sentEntry?.recipient).toBe("agent-7");
  });

  test("a peer turn with no indexed envelope is COUNTED, not silently dropped", async () => {
    const fixture = pairedFixture();
    // Two deliveries known to have happened; only one envelope is indexed —
    // the measured production shape (12 peer turns, 11 envelopes).
    fixture.peerTurns = [
      { agentSessionId: "receiver", turnIndex: 3 },
      { agentSessionId: "receiver", turnIndex: 9 },
    ];
    const payload = await payloadOf(makeDb(fixture));
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;

    expect(payload.coverage.peerTurns).toBe(2);
    expect(payload.coverage.envelopesRead).toBe(1);
    expect(payload.coverage.envelopesMissing).toBe(1);
  });

  test("envelopesMissing never goes negative when envelopes outnumber classified turns", async () => {
    const fixture = pairedFixture();
    fixture.lines = [
      { agentSessionId: "receiver", lineOrdinal: 412, line: peerLine() },
      { agentSessionId: "receiver", lineOrdinal: 500, line: peerLine() },
    ];
    const payload = await payloadOf(makeDb(fixture));
    if (payload.status !== "ok") throw new Error("expected ok");
    expect(payload.coverage.peerTurns).toBe(1);
    expect(payload.coverage.envelopesRead).toBe(2);
    expect(payload.coverage.envelopesMissing).toBe(0);
  });

  test("a turn sharing an index with a sending turn in ANOTHER session is not read as a send", async () => {
    const fixture = pairedFixture();
    // The two `inArray`s form a cross product of session ids and turn indexes,
    // so this row comes back from the query and must be narrowed away.
    fixture.sendRefs = [
      { agentSessionId: "sender", turnIndex: 7 },
      { agentSessionId: "other", turnIndex: 2 },
    ];
    fixture.turns = [
      ...(fixture.turns ?? []),
      {
        agentSessionId: "other",
        turnIndex: 2,
        toolCalls: [{ name: "SendMessage", input: { to: "x", message: "from other" } }],
        startedAt: SENT_AT,
        endedAt: SENT_END,
      },
      {
        // The impostor: session "sender", turn 2 — a real turn that the cross
        // product admits but the projection never named.
        agentSessionId: "sender",
        turnIndex: 2,
        toolCalls: [{ name: "SendMessage", input: { to: "nobody", message: "IMPOSTOR" } }],
        startedAt: SENT_AT,
        endedAt: SENT_END,
      },
    ];
    fixture.transcripts = [
      ...(fixture.transcripts ?? []),
      { agentSessionId: "other", projectId: PROJECT_A_ID },
    ];

    const payload = await payloadOf(makeDb(fixture));
    if (payload.status !== "ok") throw new Error("expected ok");
    expect(payload.feed.counts.sent).toBe(2);
    expect(payload.feed.entries.some((e) => e.body === "IMPOSTOR")).toBe(false);
  });
});

describe("messagesWidget — project scope", () => {
  test("no ?project= returns every session's messages", async () => {
    const payload = await payloadOf(makeDb(pairedFixture()));
    if (payload.status !== "ok") throw new Error("expected ok");
    expect(payload.feed.counts.sent).toBe(1);
    expect(payload.feed.counts.received).toBe(1);
  });

  test("?project= drops a session belonging to another project", async () => {
    const fixture = pairedFixture();
    fixture.transcripts = [
      { agentSessionId: "sender", projectId: PROJECT_A_ID },
      { agentSessionId: "receiver", projectId: PROJECT_B_ID },
    ];
    const payload = await payloadOf(
      makeDb(fixture),
      PROJECT_A_SLUG,
      makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }])
    );
    if (payload.status !== "ok") throw new Error("expected ok");
    expect(payload.feed.counts.sent).toBe(1);
    // The receiver lives in project B, so its delivery is out of this view —
    // and the send is therefore reported as having no delivery record, which
    // is what a scoped view can honestly say.
    expect(payload.feed.counts.received).toBe(0);
    expect(payload.feed.counts.sentUnmatched).toBe(1);
    expect(payload.coverage.peerTurns).toBe(0);
  });

  test("a transcript with a NULL project_id is dropped from a scoped view", async () => {
    const fixture = pairedFixture();
    fixture.transcripts = [
      { agentSessionId: "sender", projectId: null },
      { agentSessionId: "receiver", projectId: null },
    ];
    const payload = await payloadOf(
      makeDb(fixture),
      PROJECT_A_SLUG,
      makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }])
    );
    expect(payload.status).toBe("no-data");
  });
});
