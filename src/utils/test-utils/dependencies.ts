/**
 * Test composition helpers built on per-domain `FakeX` classes.
 *
 * New test doubles should be implemented as `FakeX` classes colocated
 * with the interface they fake — see `fake-persistence-provider.ts` for
 * the canonical example. Do NOT add new single-service stub factories
 * to this file. The helpers below compose existing `FakeX` instances
 * (`FakeSessionProvider`, `FakeGitService`, `FakeTaskService`).
 */
import { createPartialMock } from "./mocking";
import type { SessionProviderInterface } from "../../domain/session";
import type { GitServiceInterface } from "../../domain/git";
import type { TaskServiceInterface } from "../../domain/tasks";
import type { WorkspaceUtilsInterface } from "../../domain/workspace";
import { FakeSessionProvider } from "../../domain/session/fake-session-provider";
import { FakeTaskService } from "../../domain/tasks/fake-task-service";
import { FakeGitService } from "../../domain/git/fake-git-service";

/**
 * Basic domain dependencies structure for common domain functions
 */
export interface DomainDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  taskService: TaskServiceInterface;
  workspaceUtils: WorkspaceUtilsInterface;
  [key: string]: unknown; // Allow additional properties with better type safety
}

/**
 * Task-specific dependencies interface
 */
export interface TaskDependencies {
  taskService: TaskServiceInterface;
  resolveWorkspacePath: (_options?: Record<string, unknown>) => Promise<string>;
  resolveRepoPath: (_options?: Record<string, unknown>) => Promise<string>;
  [key: string]: unknown;
}

/**
 * Session-specific dependencies interface
 */
export interface SessionDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  [key: string]: unknown;
}

/**
 * Session data interface for better type safety
 */
export interface SessionData {
  name: string;
  repoName: string;
  taskId: string;
  [key: string]: unknown;
}

/**
 * Git-specific dependencies interface
 */
export interface GitDependencies {
  gitService: GitServiceInterface;
  execAsync: (
    _command: string,
    _options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: unknown) => Promise<SessionData | null>;
  getSessionWorkdir: (repoName: unknown) => string;
  [key: string]: unknown;
}

/**
 * Creates test dependencies with mock implementations
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of domain dependencies for testing
 */
export function createTestDeps(overrides: Partial<DomainDependencies> = {}): DomainDependencies {
  const sessionDB = overrides.sessionDB ?? new FakeSessionProvider();
  const gitService = overrides.gitService ?? new FakeGitService();
  const taskService = overrides.taskService ?? new FakeTaskService();

  // No FakeWorkspaceUtils exists yet — keep createPartialMock for workspace utils
  const workspaceUtils =
    overrides.workspaceUtils ??
    createPartialMock<WorkspaceUtilsInterface>({
      isWorkspace: () => Promise.resolve(true),
      isSessionWorkspace: () => false,
      getCurrentSession: () => Promise.resolve(undefined),
      getSessionFromWorkspace: () => Promise.resolve(undefined),
      resolveWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
    });

  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    ...overrides,
  };
}

/**
 * Creates task-specific test dependencies
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of task-specific dependencies for testing
 */
export function createTaskTestDeps(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  const taskService = overrides.taskService ?? new FakeTaskService();

  const resolveWorkspacePath = () => Promise.resolve("/mock/workspace/path");
  const resolveRepoPath = () => Promise.resolve("/mock/repo/path");

  return {
    taskService,
    resolveWorkspacePath,
    resolveRepoPath,
    ...overrides,
  };
}

/**
 * Creates session-specific test dependencies
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of session-specific dependencies for testing
 */
export function createSessionTestDeps(
  overrides: Partial<SessionDependencies> = {}
): SessionDependencies {
  const sessionDB = overrides.sessionDB ?? new FakeSessionProvider();
  const gitService = overrides.gitService ?? new FakeGitService();

  return {
    sessionDB,
    gitService,
    ...overrides,
  };
}

/**
 * Creates git-specific test dependencies
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of git-specific dependencies for testing
 */
export function createGitTestDeps(overrides: Partial<GitDependencies> = {}): GitDependencies {
  const gitService = overrides.gitService ?? new FakeGitService();

  const execAsync = () => Promise.resolve({ stdout: "", stderr: "" });
  const getSession = () =>
    Promise.resolve({
      name: "test-session",
      repoName: "test-repo",
      taskId: "TEST_VALUE",
    });
  const getSessionWorkdir = () => "/mock/session/workdir";

  return {
    gitService,
    execAsync,
    getSession,
    getSessionWorkdir,
    ...overrides,
  };
}
