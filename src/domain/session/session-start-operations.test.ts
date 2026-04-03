import { describe, it, expect, beforeEach, mock } from "bun:test";
const vi = { fn: mock };
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../../domain/schemas";
import { createPartialMock } from "../../utils/test-utils/mocking";
import type { SessionProviderInterface, SessionRecord } from "../session";
import type { GitServiceInterface } from "../git";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { WorkspaceUtilsInterface } from "../workspace";

function createDeps(repoUrl: string): StartSessionDependencies & {
  addSessionSpy: ReturnType<typeof mock>;
} {
  const addSessionSpy = vi.fn(async (_record: SessionRecord) => {});
  const sessionDB = createPartialMock<SessionProviderInterface>({
    addSession: addSessionSpy,
    deleteSession: vi.fn(async () => true),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  });
  const gitService = createPartialMock<GitServiceInterface>({
    clone: vi.fn(async () => ({ workdir: "/tmp/work", session: "task-md#x" })),
    branchWithoutSession: vi.fn(async () => ({ workdir: "/tmp/work", branch: "task-md#x" })),
  });
  const taskService = createPartialMock<TaskServiceInterface>({
    getTaskStatus: vi.fn(async () => "TODO"),
    setTaskStatus: vi.fn(async () => {}),
    createTaskFromTitleAndSpec: vi.fn(async (t: string, d: string) => ({
      id: "md#999",
      title: t,
      description: d,
    })) as any,
    getTask: vi.fn(async () => ({ id: "md#999" })) as any,
  });
  const workspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
    isSessionWorkspace: () => false,
  });
  const getRepositoryBackend = vi.fn(async () => {
    const backendType =
      repoUrl.startsWith("/") || repoUrl.startsWith("file://")
        ? "local"
        : repoUrl.includes("github.com")
          ? "github"
          : "remote";
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
    const added = deps.addSessionSpy.mock.calls[0]![0] as SessionRecord;
    expect(added.backendType).toBe("github");
  });

  it("sets backendType=local for local paths", async () => {
    const deps = createDeps("/Users/test/Projects/repo");
    const params = { task: "md#999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const added = deps.addSessionSpy.mock.calls[0]![0] as SessionRecord;
    expect(added.backendType).toBe("local");
  });
});
