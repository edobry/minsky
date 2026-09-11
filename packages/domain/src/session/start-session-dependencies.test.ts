/**
 * mt#5065 — `session start` carries its dependency-install outcome on the payload.
 *
 * The defect: a failed `bun install` reached only stderr, and the returned
 * object (`{ sessionId, repoUrl, repoName, taskId }`) had no field the outcome
 * could travel in — so a caller reading the tool result saw an unqualified
 * success. Measured on the mt#4705 cold-agent run against a shell project.
 *
 * Fakes throughout: the injected `installDependencies` seam is what makes the
 * FAILED branch reachable without spawning a package manager, and the injected
 * `fs.exists` decides whether a `package.json` is present.
 */
import { describe, it, expect, mock } from "bun:test";
import { join } from "path";

import { startSessionImpl } from "./start-session-operations";
import type { StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../schemas";
import type { GitServiceInterface } from "../git";
import type { WorkspaceUtilsInterface } from "../workspace";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeSessionProvider } from "./fake-session-provider";
import { RepositoryBackendType } from "../repository/index";
import { TEST_PATHS } from "../../../../src/utils/test-utils/test-constants";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_REPO_URL = "https://github.com/edobry/minsky.git";

type InstallFn = NonNullable<StartSessionDependencies["installDependencies"]>;

function makeDeps(opts: {
  manifestPresent: boolean;
  install?: InstallFn;
}): StartSessionDependencies & { install: ReturnType<typeof mock> } {
  const sessionDB = new FakeSessionProvider({
    repoPath: TEST_PATHS.SESSION_MD_160,
    sessionWorkdir: TEST_PATHS.SESSION_MD_160,
  });
  sessionDB.getSession = () => Promise.resolve(null);
  sessionDB.addSession = () => Promise.resolve();

  const gitService: GitServiceInterface = new FakeGitService();
  gitService.clone = () =>
    Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, session: TEST_UUID });
  gitService.branchWithoutSession = () =>
    Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task/md-160" });

  const taskService = new FakeTaskService({
    initialTasks: [{ id: "md#160", title: "Test Task", status: "READY" }],
  });

  const workspaceUtils: WorkspaceUtilsInterface = {
    isSessionWorkspace: mock(() => false),
    isWorkspace: mock(() => Promise.resolve(true)),
    getCurrentSession: mock(() => Promise.resolve(undefined)),
    getSessionFromWorkspace: mock(() => Promise.resolve(undefined)),
    resolveWorkspacePath: mock(() => Promise.resolve("/mock/workspace/path")),
  };

  const install = mock(
    opts.install ?? (async () => ({ success: true, output: "" }))
  ) as unknown as ReturnType<typeof mock>;

  return {
    install,
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    getRepositoryBackend: async () => ({
      repoUrl: TEST_REPO_URL,
      backendType: RepositoryBackendType.GITHUB as RepositoryBackendType,
      github: { owner: "edobry", repo: "minsky" },
    }),
    fs: {
      // The session directory itself never exists (no stale cleanup); only the
      // manifest probe answers according to the scenario.
      exists: (path: string) => opts.manifestPresent && path.endsWith(join("", "package.json")),
      rm: async () => {
        /* no-op */
      },
    },
    installDependencies: install as unknown as InstallFn,
  };
}

const params = {
  task: "md#160",
  repo: TEST_REPO_URL,
  quiet: true,
} as unknown as SessionStartParameters;

describe("mt#5065 — session start reports its dependency-install outcome", () => {
  it("SKIPS with reason no-manifest when the workspace has no package.json, and never runs the manager", async () => {
    const deps = makeDeps({ manifestPresent: false });

    const session = await startSessionImpl(params, deps);

    expect(session.dependencies).toEqual({ status: "skipped", reason: "no-manifest" });
    expect(deps.install).not.toHaveBeenCalled();
    expect(session.sessionId).toBeDefined();
  });

  it("reports installed, naming the manager, when the install succeeds", async () => {
    const deps = makeDeps({ manifestPresent: true });

    const session = await startSessionImpl(
      { ...params, packageManager: "bun" } as unknown as SessionStartParameters,
      deps
    );

    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(session.dependencies).toEqual({ status: "installed", packageManager: "bun" });
  });

  it("reports FAILED with the manager's error, and still returns the session", async () => {
    // The cold-run shape: the manager ran and did not complete.
    const deps = makeDeps({
      manifestPresent: true,
      install: async () => ({ success: false, error: "Command failed: bun install" }),
    });

    const session = await startSessionImpl(params, deps);

    expect(session.dependencies).toEqual({
      status: "failed",
      error: "Command failed: bun install",
    });
    expect(session.sessionId).toBeDefined();
  });

  it("reports FAILED when the install step throws, rather than swallowing it", async () => {
    const deps = makeDeps({
      manifestPresent: true,
      install: async () => {
        throw new Error("spawn EACCES");
      },
    });

    const session = await startSessionImpl(params, deps);

    expect(session.dependencies).toEqual({ status: "failed", error: "spawn EACCES" });
  });

  it("reports skipped with reason skipInstall when the caller opted out", async () => {
    const deps = makeDeps({ manifestPresent: true });

    const session = await startSessionImpl(
      { ...params, skipInstall: true } as unknown as SessionStartParameters,
      deps
    );

    expect(session.dependencies).toEqual({ status: "skipped", reason: "skipInstall" });
    expect(deps.install).not.toHaveBeenCalled();
  });
});
