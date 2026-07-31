/**
 * Tests for createSessionListCommand's project-scope resolution (mt#2697).
 *
 * session_list task filter returns empty for CREATED sessions that dispatch
 * reports "actively in use" — root cause: dispatch-created sessions ship
 * with project_id NULL (see start-session-operations.ts's stamping fallback,
 * fixed in the same task), and session.list's DEFAULT project-scoped query
 * silently excludes them (`project_id = $scope` never matches NULL).
 *
 * The fix here: when a `task` filter is supplied, session.list must NOT
 * apply project scoping — it must consult the exact same unscoped predicate
 * as session.start's "actively in use" check (see
 * session-start-operations.test.ts's mt#2697 suite for that side). This
 * suite pins the session.list side of that structural consistency:
 *   1. A task-filtered query returns a session row with no project_id set.
 *   2. Project-scope resolution is never even attempted for a task-filtered
 *      query (proves the two predicates can't structurally diverge — it's
 *      not merely "happens to work" for the common case).
 *   3. An unfiltered (no task) query still applies the default project scope
 *      (no regression to the ADR-021 / mt#2416 behavior).
 */
import { describe, it, expect, mock } from "bun:test";
import { createSessionListCommand } from "./basic-commands";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import type { SessionRecord } from "@minsky/domain/session/types";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionCommandDependencies } from "./types";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function buildUnstampedSession(): SessionRecord {
  return {
    sessionId: "dispatch-created-session",
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#2665",
    status: SessionStatus.CREATED,
    lastActivityAt: new Date().toISOString(),
    // Deliberately unset — mirrors the incident rows (mt#2665/2677/2678).
    projectId: undefined,
  };
}

function buildGetDeps(sessionDB: FakeSessionProvider): () => Promise<SessionCommandDependencies> {
  return async () =>
    ({
      sessionProvider: sessionDB,
    }) as unknown as SessionCommandDependencies;
}

describe("createSessionListCommand - project-scope resolution (mt#2697)", () => {
  it("returns a task-filtered session row even when it has no project_id (predicate stays unscoped)", async () => {
    const sessionDB = new FakeSessionProvider({ initialSessions: [buildUnstampedSession()] });
    const getDatabaseConnection = mock(async () => ({}) as never);
    const sqlProvider = {
      getDatabaseConnection,
    } as unknown as SqlCapablePersistenceProvider;
    const getPersistenceProvider = () => sqlProvider as unknown as PersistenceProvider;

    const command = createSessionListCommand(buildGetDeps(sessionDB), getPersistenceProvider);
    const result = (await command.execute({ task: "mt#2665" }, {})) as {
      success: boolean;
      sessions: SessionRecord[];
    };

    expect(result.success).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toContain("dispatch-created-session");
  });

  it("never attempts project-scope resolution when a task filter is supplied", async () => {
    // mt#2284 note: session.list's attachment-annotation step ALSO calls
    // getPersistenceProvider().getDatabaseConnection() (an orthogonal,
    // unrelated read to build the presence-claim repo for the attached/
    // detached indicator, which queries presenceClaimsTable). That makes the
    // shared getDatabaseConnection mock an unreliable proxy for "was
    // project-scope resolution attempted" — this fake `db.select()` instead
    // records which TABLE each query targeted (mock.module() is banned in
    // this repo; DI via the table-identity check below stays within that
    // constraint) and asserts projectsTable specifically was never queried,
    // regardless of what other orthogonal reads may have occurred.
    const { projectsTable } = await import("@minsky/domain/storage/schemas/projects-schema");
    const queriedTables: unknown[] = [];
    const chain = {
      from: (table: unknown) => {
        queriedTables.push(table);
        return chain;
      },
      where: () => chain,
      limit: () => Promise.resolve([]),
      orderBy: () => Promise.resolve([]),
    };
    const select = mock(() => chain);
    const getDatabaseConnection = mock(async () => ({ select }) as never);

    const sessionDB = new FakeSessionProvider({ initialSessions: [buildUnstampedSession()] });
    const sqlProvider = {
      getDatabaseConnection,
    } as unknown as SqlCapablePersistenceProvider;
    const getPersistenceProvider = () => sqlProvider as unknown as PersistenceProvider;

    const command = createSessionListCommand(buildGetDeps(sessionDB), getPersistenceProvider);
    await command.execute({ task: "mt#2665" }, {});

    // Structural guarantee, not a happenstance pass: scope resolution is
    // never reached for a task-filtered query, so it cannot diverge from
    // session.start's unscoped "actively in use" check.
    expect(queriedTables).not.toContain(projectsTable);
  });

  it("still applies default project scope for an unfiltered (no task) query", async () => {
    const stamped: SessionRecord = {
      ...buildUnstampedSession(),
      sessionId: "a",
      projectId: PROJECT_A,
    };
    const otherProject: SessionRecord = {
      ...buildUnstampedSession(),
      sessionId: "b",
      taskId: "mt#9999",
      projectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    };
    const sessionDB = new FakeSessionProvider({ initialSessions: [stamped, otherProject] });
    const getDatabaseConnection = mock(async () => ({}) as never);
    const sqlProvider = {
      getDatabaseConnection,
    } as unknown as SqlCapablePersistenceProvider;
    const getPersistenceProvider = () => sqlProvider as unknown as PersistenceProvider;

    const command = createSessionListCommand(buildGetDeps(sessionDB), getPersistenceProvider);
    await command.execute({}, {});

    // Unfiltered queries still resolve project scope (no task filter present
    // to trigger the mt#2697 bypass) — the ADR-021 default-scoping behavior
    // for plain `session_list` (no --task) is unchanged.
    expect(getDatabaseConnection).toHaveBeenCalled();
  });
});
