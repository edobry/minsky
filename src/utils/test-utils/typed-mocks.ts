/**
 * Type-safe test mock utilities
 *
 * Provides thin factory functions for the most commonly mocked types,
 * replacing the `as any` pattern with type-safe alternatives.
 *
 * @module typed-mocks
 */

import { mock } from "bun:test";
import type { SessionRecord, SessionProviderInterface } from "../../domain/session/types";
import type { GitServiceInterface } from "../../domain/git/types";
import type { TaskServiceInterface } from "../../domain/tasks/taskService";
import type { CommandExecutionContext } from "../../adapters/shared/command-registry";

/**
 * Wraps a partial object as a full interface type in a single place.
 * Use this instead of `partial as unknown as T` scattered across test files.
 *
 * @example
 * const svc = createPartialMock<MyService>({ doThing: mock(() => Promise.resolve()) });
 */
export function createPartialMock<T>(partial: Record<string, unknown>): T {
  return partial as unknown as T;
}

/**
 * Creates a SessionRecord with required fields filled in.
 * Overrides let tests customize only the fields that matter.
 *
 * Required fields: session, repoName, repoUrl, createdAt
 * Optional common fields: taskId
 */
export function createSessionRecordMock(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: "test-session",
    repoName: "test/repo",
    repoUrl: "https://github.com/test/repo.git",
    createdAt: new Date().toISOString(),
    taskId: "123",
    ...overrides,
  };
}

/**
 * Creates a full SessionProviderInterface mock.
 * All methods are bun mock() functions returning sensible defaults.
 * Pass overrides to customize specific method behaviors.
 */
export function createSessionProviderMock(
  overrides: Partial<SessionProviderInterface> = {}
): SessionProviderInterface {
  return {
    listSessions: mock(() => Promise.resolve([])),
    getSession: mock((_session: string) => Promise.resolve(null)),
    getSessionByTaskId: mock((_taskId: string) => Promise.resolve(null)),
    addSession: mock((_record: SessionRecord) => Promise.resolve()),
    updateSession: mock((_session: string, _updates: Partial<Omit<SessionRecord, "session">>) =>
      Promise.resolve()
    ),
    deleteSession: mock((_session: string) => Promise.resolve(true)),
    getRepoPath: mock((_record: SessionRecord | any) => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: mock((_sessionName: string) => Promise.resolve("/mock/session/workdir")),
    ...overrides,
  };
}

/**
 * Creates a full TaskServiceInterface mock.
 * All methods are bun mock() functions returning sensible defaults.
 */
export function createTaskServiceMock(
  overrides: Partial<TaskServiceInterface> = {}
): TaskServiceInterface {
  return {
    listTasks: mock((_options?: any) => Promise.resolve([])),
    getTask: mock((_taskId: string) => Promise.resolve(null)),
    getTaskStatus: mock((_taskId: string) => Promise.resolve(undefined)),
    setTaskStatus: mock((_taskId: string, _status: string) => Promise.resolve()),
    createTask: mock((_specPath: string, _options?: any) =>
      Promise.resolve({ id: "#test", title: "Test Task", status: "TODO" })
    ),
    createTaskFromTitleAndSpec: mock((_title: string, _spec: string, _options?: any) =>
      Promise.resolve({ id: "#test", title: "Test Task", status: "TODO" })
    ),
    deleteTask: mock((_taskId: string, _options?: any) => Promise.resolve(false)),
    getTaskSpecContent: mock((_taskId: string, _section?: string) =>
      Promise.resolve({
        task: { id: "#test", title: "Test Task", status: "TODO" },
        specPath: "/mock/spec.md",
        content: "# Test Task\n",
      })
    ),
    getWorkspacePath: mock(() => "/mock/workspace"),
    ...overrides,
  };
}

/**
 * Creates a full GitServiceInterface mock.
 * All methods are bun mock() functions returning sensible defaults.
 */
export function createGitServiceMock(
  overrides: Partial<GitServiceInterface> = {}
): GitServiceInterface {
  return {
    clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: "test-session" })),
    branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: "test-branch" })),
    branchWithoutSession: mock(() =>
      Promise.resolve({ workdir: "/mock/workdir", branch: "test-branch" })
    ),
    execInRepository: mock((_workdir: string, _command: string) =>
      Promise.resolve("mock git output")
    ),
    getSessionWorkdir: mock((_session: string) => "/mock/session/workdir"),
    stashChanges: mock((_repoPath: string) =>
      Promise.resolve({ workdir: "/mock/workdir", stashed: true })
    ),
    fetchLatest: mock((_repoPath: string, _remote?: string) =>
      Promise.resolve({ workdir: "/mock/workdir", updated: true })
    ),
    mergeBranch: mock((_repoPath: string, _branch: string) =>
      Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false })
    ),
    push: mock(() => Promise.resolve({ workdir: "/mock/workdir", pushed: true })),
    popStash: mock((_repoPath: string) =>
      Promise.resolve({ workdir: "/mock/workdir", stashed: false })
    ),
    getStatus: mock(() => Promise.resolve({ modified: [], untracked: [], deleted: [] })),
    getCurrentBranch: mock((_repoPath: string) => Promise.resolve("main")),
    hasUncommittedChanges: mock((_repoPath: string) => Promise.resolve(false)),
    fetchDefaultBranch: mock((_repoPath: string) => Promise.resolve("main")),
    predictMergeConflicts: mock(() =>
      Promise.resolve({
        hasConflicts: false,
        conflictingFiles: [],
        safeToMerge: true,
        analysis: "No conflicts predicted",
      } as any)
    ),
    analyzeBranchDivergence: mock(() =>
      Promise.resolve({
        ahead: 0,
        behind: 0,
        diverged: false,
        commonAncestor: "abc123",
      } as any)
    ),
    mergeWithConflictPrevention: mock(() =>
      Promise.resolve({
        merged: true,
        conflicts: false,
        workdir: "/mock/workdir",
      } as any)
    ),
    smartSessionUpdate: mock(() =>
      Promise.resolve({
        updated: true,
        alreadyMerged: false,
        workdir: "/mock/workdir",
      } as any)
    ),
    ...overrides,
  };
}

/**
 * Creates a CommandExecutionContext mock.
 * All fields are optional in the interface so this is mainly a convenience
 * for tests that need a typed context object.
 */
export function createCommandContextMock(
  overrides: Partial<CommandExecutionContext> = {}
): CommandExecutionContext {
  return {
    interface: "cli",
    debug: false,
    verbose: false,
    format: "text",
    workspacePath: "/mock/workspace",
    ...overrides,
  };
}
