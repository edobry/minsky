import { describe, it, expect, mock } from "bun:test";
const vi = { fn: mock };
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../../domain/schemas";
import type { SessionRecord } from "../session";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeWorkspaceUtils } from "../workspace/fake-workspace-utils";
import { first } from "../../utils/array-safety";

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
