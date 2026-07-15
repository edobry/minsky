/**
 * Tests for mt#2284: writeSessionAttachment self-registration write path.
 *
 * Session-SCOPED (unlike writeTaskClaim, which is session-independent):
 * requires a resolvable session, either directly (args.session/sessionId) or
 * via args.task/taskId lookup — the same resolution priority as
 * writeAgentIdToSession. Mirrors the mt#2567 per-call-repo-fallback test
 * structure in presence-write-path.test.ts.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";

type WriteSessionAttachmentFn = (args: Record<string, unknown>, actorId: string) => Promise<void>;

function getWriteSessionAttachment(server: unknown): WriteSessionAttachmentFn {
  return (
    server as unknown as {
      writeSessionAttachment: WriteSessionAttachmentFn;
    }
  ).writeSessionAttachment.bind(server as object);
}

describe("writeSessionAttachment (mt#2284)", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("upserts a session-grain claim when args.session is present directly", async () => {
    const mockRow = {
      id: "attach-1",
      subjectKind: "session",
      subjectId: "session-abc",
      actorId: "test-actor",
      ccConversationId: null as string | null,
      tty: null as string | null,
      host: null as string | null,
      sessionId: null as string | null,
      projectId: null as string | null,
      pid: null as number | null,
      entrypoint: null as string | null,
      terminalContext: null as Record<string, string> | null,
      claimedAt: new Date("2026-01-01T00:00:00Z"),
      lastRefreshedAt: new Date("2026-01-01T00:00:00Z"),
    };

    const returningMock = mock(async () => [mockRow]);
    const onConflictDoUpdateMock = mock(() => ({ returning: returningMock }));
    const valuesMock = mock((_v: Record<string, unknown>) => ({
      onConflictDoUpdate: onConflictDoUpdateMock,
    }));
    const insertMock = mock(() => ({ values: valuesMock }));

    const mockDb = {
      insert: insertMock,
      select: mock(() => undefined),
    };

    const getDatabaseConnectionMock = mock(async () => mockDb);

    const mockContainer = {
      has: (key: string) => key === "persistence",
      get: (_key: string) => ({ getDatabaseConnection: getDatabaseConnectionMock }),
    };

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
      container: mockContainer as any,
    });

    const writeSessionAttachment = getWriteSessionAttachment(server);

    await writeSessionAttachment({ session: "session-abc" }, "test-actor");

    expect(insertMock.mock.calls.length).toBe(1);
    expect(valuesMock.mock.calls.length).toBe(1);
    expect(returningMock.mock.calls.length).toBe(1);

    // The upsert payload carries subjectKind "session" and the resolved subjectId.
    const upsertValues = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertValues.subjectKind).toBe("session");
    expect(upsertValues.subjectId).toBe("session-abc");
    expect(upsertValues.actorId).toBe("test-actor");
  });

  test("resolves the session via task lookup when args.session is absent", async () => {
    const RESOLVED_SESSION_ID = "session-from-task";
    const mockRow = {
      id: "attach-2",
      subjectKind: "session",
      subjectId: RESOLVED_SESSION_ID,
      actorId: "test-actor",
      ccConversationId: null as string | null,
      tty: null as string | null,
      host: null as string | null,
      sessionId: null as string | null,
      projectId: null as string | null,
      pid: null as number | null,
      entrypoint: null as string | null,
      terminalContext: null as Record<string, string> | null,
      claimedAt: new Date("2026-01-01T00:00:00Z"),
      lastRefreshedAt: new Date("2026-01-01T00:00:00Z"),
    };

    const returningMock = mock(async () => [mockRow]);
    const onConflictDoUpdateMock = mock(() => ({ returning: returningMock }));
    const valuesMock = mock((_v: Record<string, unknown>) => ({
      onConflictDoUpdate: onConflictDoUpdateMock,
    }));
    const insertMock = mock(() => ({ values: valuesMock }));
    const mockDb = { insert: insertMock, select: mock(() => undefined) };
    const getDatabaseConnectionMock = mock(async () => mockDb);

    const getSessionByTaskIdMock = mock(async () => ({ sessionId: RESOLVED_SESSION_ID }));

    const mockContainer = {
      has: (key: string) => key === "persistence" || key === "sessionProvider",
      get: (key: string) => {
        if (key === "sessionProvider") {
          return { getSessionByTaskId: getSessionByTaskIdMock };
        }
        return { getDatabaseConnection: getDatabaseConnectionMock };
      },
    };

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
      container: mockContainer as any,
    });

    const writeSessionAttachment = getWriteSessionAttachment(server);

    await writeSessionAttachment({ task: "mt#2284" }, "test-actor");

    expect(getSessionByTaskIdMock.mock.calls.length).toBe(1);
    expect(insertMock.mock.calls.length).toBe(1);
    const upsertValues = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertValues.subjectId).toBe(RESOLVED_SESSION_ID);
  });

  test("no-ops when neither session nor task can be resolved", async () => {
    const insertMock = mock(() => ({ values: mock() }));
    const mockContainer = {
      has: (key: string) => key === "persistence",
      get: (_key: string) => ({
        getDatabaseConnection: mock(async () => ({ insert: insertMock })),
      }),
    };

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
      container: mockContainer as any,
    });

    const writeSessionAttachment = getWriteSessionAttachment(server);

    await writeSessionAttachment({}, "test-actor");

    expect(insertMock.mock.calls.length).toBe(0);
  });
});
