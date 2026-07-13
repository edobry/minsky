/**
 * Regression tests for mt#2567: writeTaskClaim per-call repo fallback.
 *
 * Pre-fix bug: writeTaskClaim had `if (!this.presenceClaimRepo) return;`
 * which made it a no-op whenever the one-shot setPresenceClaimRepository()
 * startup wiring in start-command.ts didn't fire (e.g. on proxy /
 * staleness-respawned servers). Every tool call silently no-oped.
 *
 * Fix: build the repo per-call from this.container's persistence provider
 * when presenceClaimRepo is not pre-set — mirrors the buildAskRepository
 * pattern. setPresenceClaimRepository() becomes a warm-up fast-path only.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";
import type { PresenceClaimRepository } from "@minsky/domain/presence/index";

describe("writeTaskClaim per-call repo fallback (mt#2567 regression)", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("REGRESSION: upserts via per-call repo when setPresenceClaimRepository was never called", async () => {
    // This test reproduces the mt#2567 bug:
    // - Pre-fix code: `if (!this.presenceClaimRepo) return;` → no-op; insertMock never called.
    // - Post-fix code: per-call fallback builds repo from container → insertMock called once.

    // Arrange: mock the drizzle insert chain used by DrizzlePresenceClaimRepository.upsertClaim
    const mockRow = {
      id: "test-claim-id-1234",
      subjectKind: "task",
      subjectId: "mt2567",
      actorId: "test-actor",
      ccConversationId: null as string | null,
      tty: null as string | null,
      host: null as string | null,
      sessionId: null as string | null,
      projectId: null as string | null,
      claimedAt: new Date("2026-01-01T00:00:00Z"),
      lastRefreshedAt: new Date("2026-01-01T00:00:00Z"),
    };

    const returningMock = mock(async () => [mockRow]);
    const onConflictDoUpdateMock = mock(() => ({ returning: returningMock }));
    const valuesMock = mock(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
    const insertMock = mock(() => ({ values: valuesMock }));

    // select returns undefined → resolveProjectScope will throw when chained;
    // caught by the project-scope try/catch block in writeTaskClaim.
    const mockDb = {
      insert: insertMock,
      select: mock(() => undefined),
    };

    let dbConnectionCallCount = 0;
    const getDatabaseConnectionMock = mock(async () => {
      dbConnectionCallCount++;
      return mockDb;
    });

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

    // CRITICAL: do NOT call server.setPresenceClaimRepository(...)
    // This simulates the one-shot startup wiring in start-command.ts never
    // completing before the first tool call — the exact mt#2567 failure scenario.

    const writeTaskClaim = (
      server as unknown as {
        writeTaskClaim: (args: Record<string, unknown>, actorId: string) => Promise<void>;
      }
    ).writeTaskClaim.bind(server);

    // Act
    await writeTaskClaim({ task: "mt#2567" }, "test-actor");

    // Assert: the per-call path was taken — getDatabaseConnection was called to build the repo
    expect(dbConnectionCallCount).toBeGreaterThanOrEqual(1);
    // Assert: upsertClaim reached the DB — the full insert chain ran
    expect(insertMock.mock.calls.length).toBe(1);
    expect(valuesMock.mock.calls.length).toBe(1);
    expect(returningMock.mock.calls.length).toBe(1);
  });

  test("fast-path: uses pre-set repo without going through per-call build", async () => {
    // When setPresenceClaimRepository() was called (fast-path), the pre-set repo
    // is used directly. This verifies the fast-path is still exercised.

    const upsertMock = mock(
      async (
        _input: unknown
      ): Promise<{
        id: string;
        subjectKind: "task";
        subjectId: string;
        actorId: string;
        claimedAt: string;
        lastRefreshedAt: string;
      }> => ({
        id: "test-id",
        subjectKind: "task",
        subjectId: "mt2567",
        actorId: "test-actor",
        claimedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
        lastRefreshedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      })
    );

    const fakeRepo: PresenceClaimRepository = {
      upsertClaim: upsertMock as PresenceClaimRepository["upsertClaim"],
      listClaims: mock(async () => []),
      reapStale: mock(async () => 0),
    };

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Pre-set the repo (fast-path)
    server.setPresenceClaimRepository(fakeRepo);

    const writeTaskClaim = (
      server as unknown as {
        writeTaskClaim: (args: Record<string, unknown>, actorId: string) => Promise<void>;
      }
    ).writeTaskClaim.bind(server);

    // Act
    await writeTaskClaim({ task: "mt#2567" }, "test-actor");

    // Assert: the pre-set repo's upsertClaim was called
    expect(upsertMock.mock.calls.length).toBe(1);
  });

  test("no-ops gracefully when args carry no task or taskId", async () => {
    // Verify that writeTaskClaim resolves without throwing when there is no
    // task to claim — the early-return path after building/resolving the repo.

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
      // No container → returns at the `if (!this.container?.has("persistence")) return;` guard
    });

    const writeTaskClaim = (
      server as unknown as {
        writeTaskClaim: (args: Record<string, unknown>, actorId: string) => Promise<void>;
      }
    ).writeTaskClaim.bind(server);

    // Should resolve without throwing — graceful no-op
    await expect(
      writeTaskClaim({ session: "some-session" }, "test-actor")
    ).resolves.toBeUndefined();
  });
});
