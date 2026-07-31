/**
 * Tests for the context-inspector widget (mt#2023).
 *
 * Exercises the session-picker payload shape via `createContextInspectorWidget`
 * with a mocked Drizzle-style query chain. Coverage of the snapshot endpoint
 * lives alongside the cockpit server's other endpoint tests (cockpit.test.ts).
 */

import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { postgresSessions } from "@minsky/domain/storage/schemas/session-schema";
import type { TaskProviderLike } from "../task-title-cache";
import { createContextInspectorWidget, type ContextInspectorPayload } from "./context-inspector";

const WIDGET_ID = "context-inspector";

/** Shared fixture strings — extracted to satisfy custom/no-magic-string-duplication. */
const SAMPLE_AGENT_SESSION_ID = "8e586448-17b7-43c3-becc-4d75460c9454";
const SAMPLE_CWD = "/Users/edobry/Projects/minsky";

function firstSession(payload: ContextInspectorPayload) {
  const s = payload.sessions[0];
  if (!s) throw new Error("expected at least one session in payload");
  return s;
}

interface SelectRow {
  agentSessionId: string;
  harness: string;
  startedAt: Date | null;
  endedAt: Date | null;
  cwd: string | null;
}

/** Build a minimal Drizzle-shaped mock that resolves the widget's query chain. */
function mockDbReturning(rows: SelectRow[]): PostgresJsDatabase {
  // The widget calls db.select(...).from(...).orderBy(...).limit(...) — each
  // step needs to return an object that responds to the next call and
  // ultimately resolves to the rows array (PromiseLike).
  const chain = {
    from: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (
      onFulfilled: (rows: SelectRow[]) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return {
    select: () => chain,
  } as unknown as PostgresJsDatabase;
}

describe("context-inspector widget (mt#2023)", () => {
  test("returns state:'ok' with sessions payload when DB returns rows", async () => {
    const sampleStartedAt = new Date("2026-05-20T14:30:00.000Z");
    const sampleEndedAt = new Date("2026-05-20T15:00:00.000Z");
    const rows: SelectRow[] = [
      {
        agentSessionId: SAMPLE_AGENT_SESSION_ID,
        harness: "claude_code",
        startedAt: sampleStartedAt,
        endedAt: sampleEndedAt,
        cwd: SAMPLE_CWD,
      },
    ];

    const widget = createContextInspectorWidget(async () => mockDbReturning(rows));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return; // for type narrowing

    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toHaveLength(1);
    const s = firstSession(payload);
    expect(s.agentSessionId).toBe(SAMPLE_AGENT_SESSION_ID);
    expect(s.harness).toBe("claude_code");
    expect(s.startedAt).toBe(sampleStartedAt.toISOString());
    expect(s.endedAt).toBe(sampleEndedAt.toISOString());
    expect(s.cwd).toBe(SAMPLE_CWD);
    // Label format: "<YYYY-MM-DD HH:MM> · <cwd-tail-2> · <session-prefix-8>"
    expect(s.label).toContain("2026-05-20 14:30");
    expect(s.label).toContain("Projects/minsky");
    expect(s.label).toContain("8e586448");
  });

  test("returns state:'ok' with empty sessions list when DB has no rows", async () => {
    const widget = createContextInspectorWidget(async () => mockDbReturning([]));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toEqual([]);
  });

  test("handles null cwd and null timestamps defensively", async () => {
    const rows: SelectRow[] = [
      {
        agentSessionId: "abc12345-aaaa-bbbb-cccc-ddddeeeeffff",
        harness: "claude_code",
        startedAt: null,
        endedAt: null,
        cwd: null,
      },
    ];
    const widget = createContextInspectorWidget(async () => mockDbReturning(rows));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toHaveLength(1);
    const s = firstSession(payload);
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
    expect(s.cwd).toBeNull();
    expect(s.label).toContain("no-ts");
    expect(s.label).toContain("unknown");
    expect(s.label).toContain("abc12345");
  });

  test("returns state:'degraded' when DB factory throws", async () => {
    const widget = createContextInspectorWidget(async () => {
      throw new Error("simulated DB connection failure");
    });
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    expect(result.reason).toContain("simulated DB connection failure");
  });

  test("widget metadata: id, title, polling updateMode", () => {
    const widget = createContextInspectorWidget(async () => mockDbReturning([]));
    expect(widget.id).toBe(WIDGET_ID);
    expect(widget.title).toBe("Context");
    expect(widget.updateMode).toEqual({ type: "polling", intervalMs: 15000 });
  });
});

// ---------------------------------------------------------------------------
// Conversation-labeling precedence (mt#2770)
// ---------------------------------------------------------------------------

interface MultiTableFixture {
  transcripts: SelectRow[];
  links?: {
    agentSessionId: string;
    minskySessionId: string;
    confidence: number | null;
    detectedAt: Date | null;
  }[];
  sessions?: { sessionId: string; taskId: string | null }[];
  turns?: { agentSessionId: string; turnIndex: number; userText: string | null }[];
  spawns?: { childAgentSessionId: string | null; agentKind: string | null }[];
  invocations?: {
    agentSessionId: string | null;
    taskId: string;
    agentType: string;
    startedAt: Date | null;
  }[];
}

/**
 * Build a mock `PostgresJsDatabase` whose `.select().from(<table>)` chain
 * branches on the drizzle table object identity — needed because
 * `createContextInspectorWidget`'s enrichment step queries six different
 * tables in one `fetch()` call (unlike the single-table baseline mock above).
 */
function mockMultiTableDb(fixture: MultiTableFixture): PostgresJsDatabase {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === agentTranscriptsTable) {
          return {
            orderBy: () => ({ limit: () => Promise.resolve(fixture.transcripts) }),
          };
        }
        if (table === minskySessionLinksTable) {
          return { where: () => Promise.resolve(fixture.links ?? []) };
        }
        if (table === agentTranscriptTurnsTable) {
          return { where: () => Promise.resolve(fixture.turns ?? []) };
        }
        if (table === agentSpawnsTable) {
          return { where: () => Promise.resolve(fixture.spawns ?? []) };
        }
        if (table === subagentInvocationsTable) {
          return { where: () => Promise.resolve(fixture.invocations ?? []) };
        }
        if (table === postgresSessions) {
          return { where: () => Promise.resolve(fixture.sessions ?? []) };
        }
        throw new Error("mockMultiTableDb: unexpected table in .from()");
      },
    }),
  } as unknown as PostgresJsDatabase;
}

function stubTaskProvider(titles: Record<string, string>): TaskProviderLike {
  return {
    async getTask(taskId: string) {
      const title = titles[taskId];
      return title ? { title } : null;
    },
    async getTasks(ids: string[]) {
      return ids.filter((id) => titles[id]).map((id) => ({ id, title: titles[id] as string }));
    },
  };
}

describe("context-inspector widget — conversation labeling (mt#2770)", () => {
  const AGENT_SESSION_ID = SAMPLE_AGENT_SESSION_ID;
  const startedAt = new Date("2026-07-13T20:40:00.000Z");
  const baseTranscript: SelectRow = {
    agentSessionId: AGENT_SESSION_ID,
    harness: "claude_code",
    startedAt,
    endedAt: null,
    cwd: SAMPLE_CWD,
  };

  test("tier 1: bound task title wins when minsky_session_links + sessions + task provider all resolve", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      links: [
        {
          agentSessionId: AGENT_SESSION_ID,
          minskySessionId: "workspace-session-1",
          confidence: 1.0,
          detectedAt: new Date("2026-07-13T20:41:00.000Z"),
        },
      ],
      sessions: [{ sessionId: "workspace-session-1", taskId: "mt#2770" }],
      turns: [
        { agentSessionId: AGENT_SESSION_ID, turnIndex: 0, userText: "implement the labeling task" },
      ],
    });
    const widget = createContextInspectorWidget(
      async () => db,
      async () =>
        stubTaskProvider({
          "mt#2770": "Conversation labeling: task-binding + first-prompt snippet labels",
        })
    );

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).toBe("Conversation labeling: task-binding + first-prompt snippet labels");
  });

  test("tier 2: first-user-prompt snippet when no session link resolves (sparse minsky_session_links)", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      links: [], // empty — the sparse case (mt#2441/mt#2756 not yet landed)
      turns: [
        {
          agentSessionId: AGENT_SESSION_ID,
          turnIndex: 0,
          userText: "Please investigate why the reviewer bot keeps failing on CI runs",
        },
      ],
    });
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label.startsWith("Please investigate")).toBe(true);
  });

  test("tier 2 (mt#2784): a markup-only first turn falls to the next substantive user turn, never raw XML", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      links: [],
      turns: [
        {
          agentSessionId: AGENT_SESSION_ID,
          turnIndex: 0,
          userText: "<command-message>error-handling</command-message>",
        },
        {
          agentSessionId: AGENT_SESSION_ID,
          turnIndex: 1,
          userText: "why does the reviewer bot keep failing on CI runs",
        },
      ],
    });
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).not.toContain("<command-");
    expect(s.label.startsWith("why does the reviewer bot")).toBe(true);
  });

  test("tier 2 -> tier 4 (mt#2784): a conversation with ONLY markup turns falls to the timestamp·cwd fallback", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      links: [],
      turns: [
        {
          agentSessionId: AGENT_SESSION_ID,
          turnIndex: 0,
          userText: "<command-message>error-handling</command-message>",
        },
      ],
    });
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).not.toContain("<command-");
    expect(s.label).toContain("2026-07-13 20:40");
  });

  test("tier 3: subagent descriptor from subagent_invocations when no link or first-user text resolves", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      invocations: [
        {
          agentSessionId: AGENT_SESSION_ID,
          taskId: "mt#2770",
          agentType: "refactorer",
          startedAt: new Date("2026-07-13T20:40:05.000Z"),
        },
      ],
    });
    const widget = createContextInspectorWidget(
      async () => db,
      async () => stubTaskProvider({ "mt#2770": "Conversation labeling" })
    );

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).toBe("refactorer — Conversation labeling");
  });

  test("tier 3: agent_spawns agentKind used when no subagent_invocations row resolves", async () => {
    const db = mockMultiTableDb({
      transcripts: [baseTranscript],
      spawns: [{ childAgentSessionId: AGENT_SESSION_ID, agentKind: "Explore" }],
    });
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).toBe("Explore subagent");
  });

  test("tier 4: falls back to timestamp·cwd·id label when no enrichment resolves at all", async () => {
    const db = mockMultiTableDb({ transcripts: [baseTranscript] });
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).toContain("2026-07-13 20:40");
    expect(s.label).toContain("Projects/minsky");
    expect(s.label).toContain("8e586448");
  });

  test("enrichment query failure degrades to the fallback label without erroring the whole widget", async () => {
    // The baseline single-shape mockDbReturning() chain doesn't support the
    // enrichment queries' `.where()` step — this proves the widget degrades
    // gracefully (state: 'ok', fallback label) rather than returning
    // state: 'degraded' for the whole widget.
    const db = mockDbReturning([baseTranscript]);
    const widget = createContextInspectorWidget(async () => db);

    const result = await widget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const s = firstSession(result.payload as ContextInspectorPayload);
    expect(s.label).toContain("8e586448");
  });
});
