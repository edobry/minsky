import { describe, it, expect, beforeEach, vi } from "bun:test";
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../../domain/schemas";

function createDeps(repoUrl: string): StartSessionDependencies {
  const sessionDB = {
    addSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as any;
  const gitService = {
    clone: vi.fn(async () => ({ workdir: "/tmp/work", session: "task-md#x" })),
    branchWithoutSession: vi.fn(async () => ({ workdir: "/tmp/work", branch: "task-md#x" })),
  } as any;
  const taskService = {
    getTaskStatus: vi.fn(async () => "TODO"),
    setTaskStatus: vi.fn(async () => {}),
    createTaskFromTitleAndSpec: vi.fn(async (t: string, d: string) => ({
      id: "md#999",
      title: t,
      description: d,
    })),
    getTask: vi.fn(async () => ({ id: "md#999" })),
  } as any;
  const workspaceUtils = {
    isSessionWorkspace: vi.fn(async () => false),
  } as any;
  const resolveRepositoryAndBackend = vi.fn(
    async (options?: { repoParam?: string; cwd?: string }) => {
      const backendType =
        repoUrl.startsWith("/") || repoUrl.startsWith("file://")
          ? "local"
          : repoUrl.includes("github.com")
            ? "github"
            : "remote";
      return { repoUrl, backendType };
    }
  );
  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    resolveRepositoryAndBackend,
  } as StartSessionDependencies;
}

describe("startSessionImpl - backendType", () => {
  it("sets backendType=github for GitHub URLs", async () => {
    const deps = createDeps("https://github.com/owner/repo.git");
    const params: SessionStartParameters = { task: "md#999" } as any;
    await startSessionImpl(params, deps);
    const added = (deps.sessionDB.addSession as any).mock.calls[0][0];
    expect(added.backendType).toBe("github");
  });

  it("sets backendType=local for local paths", async () => {
    const deps = createDeps("/Users/test/Projects/repo");
    const params: SessionStartParameters = { task: "md#999" } as any;
    await startSessionImpl(params, deps);
    const added = (deps.sessionDB.addSession as any).mock.calls[0][0];
    expect(added.backendType).toBe("local");
  });
});
