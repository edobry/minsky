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
      listAllForKind: mock(async () => []),
      deleteBySubject: mock(async () => 0),
      deleteByIds: mock(async () => 0),
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

  /**
   * mt#3889: a tool that READS presence must not WRITE it.
   *
   * The probe in `user-preferences.mdc §Probe before claiming a shared resource`
   * opens with `tasks_claims_list`. While that call upserted a claim on the task
   * it was asked about, the probe refreshed the very `lastRefreshedAt` it then
   * reported — so a long-stale claim read back as `stale: false`, and an agent
   * checking whether anyone else held a task saw its own write.
   */
  describe("presence-reading tools are exempt from the presence write (mt#3889)", () => {
    /** A fast-path repo whose upsert calls are counted. */
    function serverWithCountingRepo() {
      const upsertMock = mock(async (_input: unknown) => ({
        id: "test-id",
        subjectKind: "task" as const,
        subjectId: "mt3889",
        actorId: "test-actor",
        claimedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
        lastRefreshedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      }));

      const fakeRepo: PresenceClaimRepository = {
        upsertClaim: upsertMock as unknown as PresenceClaimRepository["upsertClaim"],
        listClaims: mock(async () => []),
        reapStale: mock(async () => 0),
        listAllForKind: mock(async () => []),
        deleteBySubject: mock(async () => 0),
        deleteByIds: mock(async () => 0),
      };

      return { fakeRepo, upsertMock };
    }

    async function writeTaskClaimFor(
      fakeRepo: PresenceClaimRepository,
      args: Record<string, unknown>,
      readsPresence?: boolean
    ) {
      const { MinskyMCPServer } = await import("./server");
      const server = new MinskyMCPServer({
        name: "Test Server",
        version: "1.0.0",
        projectContext: { repositoryPath: "/mock/test-repo" },
      });
      server.setPresenceClaimRepository(fakeRepo);

      const writeTaskClaim = (
        server as unknown as {
          writeTaskClaim: (
            args: Record<string, unknown>,
            actorId: string,
            readsPresence?: boolean
          ) => Promise<void>;
        }
      ).writeTaskClaim.bind(server);

      await writeTaskClaim(args, "test-actor", readsPresence);
    }

    test("a tool declaring readsPresence does NOT upsert a claim for the task it reports on", async () => {
      const { fakeRepo, upsertMock } = serverWithCountingRepo();
      await writeTaskClaimFor(fakeRepo, { taskId: "mt#3889" }, true);
      expect(upsertMock.mock.calls.length).toBe(0);
    });

    test("a tool that does NOT declare it, carrying the same args, still writes its claim", async () => {
      // Bounds the exemption: presence is touch-based by design, so this must
      // stay a narrow carve-out and not become a general "reads don't claim".
      const { fakeRepo, upsertMock } = serverWithCountingRepo();
      await writeTaskClaimFor(fakeRepo, { taskId: "mt#3889" }, false);
      expect(upsertMock.mock.calls.length).toBe(1);
    });

    test("an absent flag preserves the pre-mt#3889 write behavior", async () => {
      // The param is optional; a caller that does not pass it is unaffected.
      const { fakeRepo, upsertMock } = serverWithCountingRepo();
      await writeTaskClaimFor(fakeRepo, { taskId: "mt#3889" });
      expect(upsertMock.mock.calls.length).toBe(1);
    });

    /**
     * mt#3903: the two remaining mt#3889 cases — the Claude-Desktop underscore
     * alias, and a tool whose name merely CONTAINS an exempt one — are no longer
     * testable, because they are no longer possible. Both were artifacts of
     * matching NAMES against a list; the exemption now travels as a flag on the
     * tool, so there is no name to spell two ways and no string to be a
     * substring of. Asserting them here would test the test, not the code.
     *
     * What replaces them is a check the name list could not express: that the
     * declaration survives the trip from the command definition to the tool the
     * server actually reads. A field declared and not threaded is exactly how
     * this class of defect fails silently.
     */
    test("readsPresence is declared on tasks.claims.list and survives registration", async () => {
      const { createTasksClaimsListCommand } = await import(
        "../adapters/shared/commands/tasks/claims-command"
      );
      const command = createTasksClaimsListCommand(() => undefined);
      expect(command.readsPresence).toBe(true);

      const { CommandMapper } = await import("./command-mapper");
      const registered: Array<{ name: string; readsPresence?: boolean }> = [];
      const mapper = new CommandMapper(
        {
          addTool: (tool: { name: string; readsPresence?: boolean }) => {
            registered.push(tool);
          },
        } as never,
        { repositoryPath: "/mock/test-repo" }
      );
      mapper.addCommand({ ...command, handler: async () => ({}) } as never);

      // One command in, one tool out. Asserted on the count rather than by
      // searching for a name: the registered tool is named from the command's
      // `name` ("list"), not its `id` ("tasks.claims.list"), and a name-based
      // lookup that silently found nothing would pass `undefined?.readsPresence`
      // straight into a vacuous assertion.
      expect(registered.length).toBe(1);
      expect(registered[0]?.readsPresence).toBe(true);
    });
  });

  /**
   * mt#3945: the claim records the conversation `actorId` names, not an env var.
   *
   * Wiring check, not logic — `presence-conversation.test.ts` owns the
   * derivation's cases. What this asserts is that the derived value actually
   * reaches `upsertClaim`, which is the half a pure unit test cannot see and
   * the half that was broken: the old code read `CC_CONVERSATION_ID`, so every
   * one of the 6076 task rows in prod carried null.
   */
  test("the upserted claim carries the conversation the actorId names (mt#3945)", async () => {
    const upsertMock = mock(async (_input: unknown) => ({
      id: "test-id",
      subjectKind: "task" as const,
      subjectId: "mt3945",
      actorId: "test-actor",
      claimedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      lastRefreshedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    }));

    const fakeRepo: PresenceClaimRepository = {
      upsertClaim: upsertMock as unknown as PresenceClaimRepository["upsertClaim"],
      listClaims: mock(async () => []),
      reapStale: mock(async () => 0),
      listAllForKind: mock(async () => []),
      deleteBySubject: mock(async () => 0),
      deleteByIds: mock(async () => 0),
    };

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    server.setPresenceClaimRepository(fakeRepo);

    const conversationId = "8f3a2d1b-4c5e-4a6f-9b7c-0d1e2f3a4b5c";
    const writeTaskClaim = (
      server as unknown as {
        writeTaskClaim: (args: Record<string, unknown>, actorId: string) => Promise<void>;
      }
    ).writeTaskClaim.bind(server);

    await writeTaskClaim({ task: "mt#3945" }, `com.anthropic.claude-code:conv:${conversationId}`);

    expect(upsertMock.mock.calls.length).toBe(1);
    // Asserted against the actorId's own segment, so this holds whatever
    // CLAUDE_CODE_SESSION_ID happens to be in the test runner's environment —
    // which is the point: the derived value wins over the ambient one.
    const claim = upsertMock.mock.calls[0]?.[0] as { ccConversationId?: string };
    expect(claim.ccConversationId).toBe(conversationId);
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
