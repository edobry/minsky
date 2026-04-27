/**
 * Tests for filesystem failure handling in deleteSessionImpl.
 *
 * Verifies that when filesystem removal fails during session deletion,
 * the DB record is preserved to prevent orphan directories (mt#789).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { deleteSessionImpl } from "./session-lifecycle-operations";
import type { SessionRecord } from "./types";

/** Minimal in-memory session provider sufficient for deleteSessionImpl. */
function makeSessionDB(sessions: SessionRecord[]) {
  const store = new Map(sessions.map((s) => [s.session, s]));
  return {
    getSession: mock(async (id: string) => store.get(id) ?? null),
    getSessionByTaskId: mock(async () => null),
    listSessions: mock(async () => Array.from(store.values())),
    addSession: mock(async () => {}),
    updateSession: mock(async () => {}),
    deleteSession: mock(async (id: string) => {
      const existed = store.has(id);
      store.delete(id);
      return existed;
    }),
    getRepoPath: mock(async () => "/mock/repo"),
    getSessionWorkdir: mock(async (id: string) => `/mock/sessions/${id}`),
  };
}

describe("deleteSessionImpl — filesystem failure preserves DB record (mt#789)", () => {
  const SESSION_ID = "test-session-fs-fail";

  let sessionRecord: SessionRecord;

  beforeEach(() => {
    sessionRecord = {
      session: SESSION_ID,
      repoUrl: "https://github.com/edobry/minsky.git",
      repoName: "minsky",
      taskId: "mt#789",
      createdAt: new Date().toISOString(),
    };
  });

  it("preserves DB record when rmSync throws", async () => {
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID, force: false },
      {
        sessionDB,
        fs: {
          existsSync: () => true,
          rmSync: () => {
            throw new Error("EPERM: operation not permitted");
          },
        },
      }
    );

    // Session should NOT be deleted
    expect(result.deleted).toBe(false);
    expect(result.error).toContain("DB record preserved");

    // DB record should still exist
    const record = await sessionDB.getSession(SESSION_ID);
    expect(record).not.toBeNull();
    expect(record?.session).toBe(SESSION_ID);

    // deleteSession should NOT have been called
    expect(sessionDB.deleteSession).not.toHaveBeenCalled();
  });

  it("still deletes DB record when directory does not exist", async () => {
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID, force: false },
      {
        sessionDB,
        fs: {
          existsSync: () => false,
          rmSync: () => {
            throw new Error("should not be called");
          },
        },
      }
    );

    // Session should be deleted (directory didn't exist, so no fs error)
    expect(result.deleted).toBe(true);

    // DB record should be gone
    const record = await sessionDB.getSession(SESSION_ID);
    expect(record).toBeNull();
  });

  it("deletes both directory and DB record on success", async () => {
    const sessionDB = makeSessionDB([sessionRecord]);
    const rmSyncMock = mock(() => {});

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID, force: false },
      {
        sessionDB,
        fs: {
          existsSync: () => true,
          rmSync: rmSyncMock,
        },
      }
    );

    expect(result.deleted).toBe(true);
    expect(rmSyncMock).toHaveBeenCalled();

    // DB record should be gone
    const record = await sessionDB.getSession(SESSION_ID);
    expect(record).toBeNull();
  });
});
