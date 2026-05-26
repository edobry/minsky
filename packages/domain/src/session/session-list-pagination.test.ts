/**
 * Tests for listSessionsImpl pagination threading (mt#933).
 *
 * Verifies that:
 *   - default limit/offset are applied when params omit them
 *   - recency ordering (lastActivityAt desc → createdAt desc) is pushed down
 *   - task/since/until filters are forwarded as storage-layer options
 */
import { describe, test, expect } from "bun:test";
import { listSessionsImpl } from "./session-lifecycle-operations";
import type { SessionProviderInterface, SessionListOptions, SessionRecord } from "./types";

function makeCapturingProvider() {
  let captured: SessionListOptions | undefined;
  const provider: SessionProviderInterface = {
    listSessions: async (options?: SessionListOptions) => {
      captured = options;
      return [] as SessionRecord[];
    },
    getSession: async () => null,
    getSessionByTaskId: async () => null,
    addSession: async () => {},
    updateSession: async () => {},
    deleteSession: async () => false,
    getRepoPath: async () => "/tmp",
    getSessionWorkdir: async () => "/tmp",
  };
  return { provider, getCaptured: () => captured };
}

describe("listSessionsImpl pagination (mt#933)", () => {
  test("applies default limit=20 and offset=0 when params omit them", async () => {
    const { provider, getCaptured } = makeCapturingProvider();
    await listSessionsImpl({}, { sessionDB: provider });
    const opts = getCaptured();
    expect(opts).toBeDefined();
    expect(opts?.limit).toBe(20);
    expect(opts?.offset).toBe(0);
  });

  test("forwards explicit limit and offset", async () => {
    const { provider, getCaptured } = makeCapturingProvider();
    await listSessionsImpl({ limit: 5, offset: 5 }, { sessionDB: provider });
    const opts = getCaptured();
    expect(opts?.limit).toBe(5);
    expect(opts?.offset).toBe(5);
  });

  test("sorts by lastActivityAt desc then createdAt desc by default", async () => {
    const { provider, getCaptured } = makeCapturingProvider();
    await listSessionsImpl({}, { sessionDB: provider });
    const opts = getCaptured();
    expect(opts?.orderBy).toEqual([
      { field: "lastActivityAt", direction: "desc" },
      { field: "createdAt", direction: "desc" },
    ]);
  });

  test("threads task / since / until into storage options", async () => {
    const { provider, getCaptured } = makeCapturingProvider();
    await listSessionsImpl(
      {
        task: "mt#933",
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-31T00:00:00Z",
      },
      { sessionDB: provider }
    );
    const opts = getCaptured();
    expect(opts?.taskId).toBe("mt#933");
    expect(opts?.createdAfter).toBe("2026-01-01T00:00:00Z");
    expect(opts?.createdBefore).toBe("2026-12-31T00:00:00Z");
  });
});
