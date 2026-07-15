/**
 * Regression test: session_start kind-aware status guard (mt#1870)
 *
 * mt#1812 added the `kind` field but session_start's PLANNING/READY guards
 * were kind-blind. The implementation-kind path requires READY (via the
 * PLANNING→READY planning gate). The umbrella-kind workflow has no READY
 * state — PLANNING→IN-PROGRESS is the direct transition. Without kind
 * dispatch, every umbrella task in PLANNING hit the "Set status to READY"
 * error with no way forward.
 *
 * These tests verify:
 *   1. implementation-kind in PLANNING: rejected with the READY-gate message.
 *   2. implementation-kind in READY: succeeds, transitions to IN-PROGRESS.
 *   3. umbrella-kind in PLANNING: succeeds, transitions to IN-PROGRESS.
 *   4. umbrella-kind in TODO: still rejected (must go through PLANNING).
 */

import { describe, it, expect, mock } from "bun:test";
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../schemas";
import type { SessionRecord } from "./types";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeWorkspaceUtils } from "../workspace/fake-workspace-utils";

const vi = { fn: mock };

function createDeps(opts: { kind: string; initialStatus: string }): StartSessionDependencies & {
  setStatusSpy: ReturnType<typeof mock>;
} {
  const sessionDB = new FakeSessionProvider();
  sessionDB.addSession = vi.fn(async (_record: SessionRecord) => {});

  const gitService = new FakeGitService();
  gitService.clone = vi.fn(async () => ({ workdir: "/tmp/work", session: "test-uuid-session" }));
  gitService.branchWithoutSession = vi.fn(async () => ({
    workdir: "/tmp/work",
    branch: "task/mt-9999",
  }));

  const setStatusSpy = vi.fn(async () => {});
  const taskService = new FakeTaskService();
  taskService.getTask = vi.fn(async () => ({
    id: "mt#9999",
    title: "Test task",
    kind: opts.kind,
  })) as any;
  taskService.getTaskStatus = vi.fn(async () => opts.initialStatus);
  taskService.setTaskStatus = setStatusSpy;
  taskService.getTaskSpecContent = vi.fn(async () => null) as any;

  const workspaceUtils = new FakeWorkspaceUtils();
  const getRepositoryBackend = vi.fn(async () => ({
    repoUrl: "https://github.com/owner/repo.git",
    backendType: "github" as const,
  }));

  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    getRepositoryBackend,
    setStatusSpy,
  } as unknown as StartSessionDependencies & { setStatusSpy: ReturnType<typeof mock> };
}

describe("startSessionImpl kind-aware status gate (mt#1870)", () => {
  it("rejects implementation-kind task in PLANNING with the READY-gate error", async () => {
    const deps = createDeps({ kind: "implementation", initialStatus: "PLANNING" });
    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    await expect(startSessionImpl(params, deps)).rejects.toThrow(
      /READY when investigation is done/
    );
  });

  it("accepts implementation-kind task in READY and transitions to IN-PROGRESS", async () => {
    const deps = createDeps({ kind: "implementation", initialStatus: "READY" });
    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    // Last call should be setTaskStatus to IN-PROGRESS
    const calls = deps.setStatusSpy.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toBe("IN-PROGRESS");
  });

  it("accepts umbrella-kind task in PLANNING and transitions to IN-PROGRESS", async () => {
    const deps = createDeps({ kind: "umbrella", initialStatus: "PLANNING" });
    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const calls = deps.setStatusSpy.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toBe("IN-PROGRESS");
  });

  it("rejects umbrella-kind task in TODO (must go through PLANNING first)", async () => {
    const deps = createDeps({ kind: "umbrella", initialStatus: "TODO" });
    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/PLANNING/);
  });

  it("refuses state-ops-kind tasks regardless of status — no-session flow (mt#455)", async () => {
    const deps = createDeps({ kind: "state-ops", initialStatus: "READY" });
    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/without a session/);
  });

  it("defaults to implementation behavior when task has no kind field (back-compat)", async () => {
    // Task object returned without a kind property
    const sessionDB = new FakeSessionProvider();
    sessionDB.addSession = vi.fn(async (_record: SessionRecord) => {});
    const gitService = new FakeGitService();
    gitService.clone = vi.fn(async () => ({ workdir: "/tmp/work", session: "test-uuid-session" }));
    gitService.branchWithoutSession = vi.fn(async () => ({
      workdir: "/tmp/work",
      branch: "task/mt-9999",
    }));

    const taskService = new FakeTaskService();
    taskService.getTask = vi.fn(async () => ({ id: "mt#9999", title: "No-kind task" })) as any;
    taskService.getTaskStatus = vi.fn(async () => "PLANNING");
    taskService.setTaskStatus = vi.fn(async () => {});
    taskService.getTaskSpecContent = vi.fn(async () => null) as any;
    const workspaceUtils = new FakeWorkspaceUtils();
    const getRepositoryBackend = vi.fn(async () => ({
      repoUrl: "https://github.com/owner/repo.git",
      backendType: "github" as const,
    }));

    const deps = {
      sessionDB,
      gitService,
      taskService,
      workspaceUtils,
      getRepositoryBackend,
    } as unknown as StartSessionDependencies;

    const params = { task: "mt#9999" } as unknown as SessionStartParameters;
    // No kind → default to implementation behavior → PLANNING rejected with READY-gate error
    await expect(startSessionImpl(params, deps)).rejects.toThrow(
      /READY when investigation is done/
    );
  });
});
