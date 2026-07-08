import { describe, it, expect, mock } from "bun:test";
const vi = { fn: mock };
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../schemas";
import type { SessionRecord } from "../session";
import { SessionStatus } from "./types";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeWorkspaceUtils } from "../workspace/fake-workspace-utils";
import { first } from "@minsky/shared/array-safety";

function createDeps(repoUrl: string): StartSessionDependencies & {
  addSessionSpy: ReturnType<typeof mock>;
} {
  const addSessionSpy = vi.fn(async (_record: SessionRecord) => {});
  const sessionDB = new FakeSessionProvider();
  sessionDB.addSession = addSessionSpy;

  const gitService = new FakeGitService();
  gitService.clone = vi.fn(async () => ({ workdir: "/tmp/work", session: "test-uuid-session" }));
  gitService.branchWithoutSession = vi.fn(async () => ({
    workdir: "/tmp/work",
    branch: "task/md-x",
  }));

  const taskService = new FakeTaskService();
  taskService.getTaskStatus = vi.fn(async () => "READY");
  taskService.setTaskStatus = vi.fn(async () => {});
  taskService.createTaskFromTitleAndSpec = vi.fn(async (t: string, d: string) => ({
    id: "md#999",
    title: t,
    description: d,
  })) as any;
  taskService.getTask = vi.fn(async () => ({ id: "md#999" })) as any;

  const workspaceUtils = new FakeWorkspaceUtils();

  const getRepositoryBackend = vi.fn(async () => {
    const backendType = repoUrl.includes("github.com") ? "github" : "github";
    return { repoUrl, backendType };
  });
  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    getRepositoryBackend,
    addSessionSpy,
  } as unknown as StartSessionDependencies & { addSessionSpy: ReturnType<typeof mock> };
}

describe("startSessionImpl - backendType", () => {
  it("sets backendType=github for GitHub URLs", async () => {
    const deps = createDeps("https://github.com/owner/repo.git");
    const params = { task: "md#999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.backendType).toBe("github");
  });

  it("sets backendType=github for non-GitHub URLs (only github is supported)", async () => {
    const deps = createDeps("https://example.com/owner/repo.git");
    const params = { task: "md#999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.backendType).toBe("github");
  });
});

// mt#2697: session_list task filter returns empty for CREATED sessions that
// dispatch reports "actively in use" — the "actively in use" precondition
// check and session.list's task-filtered query must consult the same
// predicate. This suite pins the "actively in use" side: it must find a
// pre-existing session for the task REGARDLESS of that session's project_id
// (dispatch-created sessions shipped with project_id NULL — see
// fake-session-provider.test.ts and basic-commands.test.ts for the
// session.list side of the same predicate).
const EXISTING_SESSION_ID = "existing-session-id-mt2697";

function buildExistingSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: EXISTING_SESSION_ID,
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: new Date().toISOString(),
    taskId: "md#999",
    status: SessionStatus.CREATED,
    lastActivityAt: new Date().toISOString(),
    // Deliberately unset by default — mirrors the incident rows
    // (mt#2665/2677/2678), all of which had projectId: null.
    projectId: undefined,
    ...overrides,
  };
}

describe("startSessionImpl - actively-in-use check (mt#2697)", () => {
  it("blocks starting a new session when an unstamped (project_id undefined) CREATED session already exists for the task", async () => {
    const sessionDB = new FakeSessionProvider({ initialSessions: [buildExistingSession()] });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/actively in use/);
  });

  it("still blocks when the existing session IS project-stamped (predicate stays unscoped either way)", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [
        buildExistingSession({ projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      ],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/actively in use/);
  });

  it("does not block starting a session for an unrelated task", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildExistingSession({ taskId: "md#111" })],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);
    // No throw — succeeded, session for md#999 was created (not blocked by md#111's row).
  });
});
