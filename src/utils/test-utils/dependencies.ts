const TEST_VALUE = 123;

/**
 * Dependency injection utilities for tests
 * This module provides functions to create test dependencies with sensible defaults
 */
import { createPartialMock } from "./mocking";
import type { SessionProviderInterface } from "../../domain/session";
import type { GitServiceInterface } from "../../domain/git";
import type { TaskServiceInterface } from "../../domain/tasks";
import type { WorkspaceUtilsInterface } from "../../domain/workspace";
import type { RepositoryBackend } from "../../domain/repository";

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
  getSession: (_name: unknown) => Promise<SessionData | null>;
  getSessionWorkdir: (_repoName: unknown) => string;
  [key: string]: unknown;
}

/**
 * Creates test dependencies with mock implementations
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of domain dependencies for testing
 */
export function createTestDeps(__overrides: Partial<DomainDependencies> = {}): DomainDependencies {
  // Create a more complete implementation using createPartialMock
  // This avoids type errors by letting TypeScript infer the required interface methods
  const sessionDB = createPartialMock<SessionProviderInterface>({
    listSessions: () => Promise.resolve([]),
    getSession: () => Promise.resolve(null),
    getSessionByTaskId: () => Promise.resolve(null),
    addSession: () => Promise.resolve(),
    updateSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(true),
    getRepoPath: () => Promise.resolve("/mock/repo/path"),
    getSessionWorkdir: () => Promise.resolve("/mock/workdir/path"),
    ...(overrides.sessionDB || {}),
  });

  // Create default git service mock using createPartialMock
  const gitService = createPartialMock<GitServiceInterface>({
    // Use specific implementation signatures that match the interface
    clone: () => Promise.resolve({ _workdir: "/mock/workdir", _session: "test-session" }),
    branch: () => Promise.resolve({ _workdir: "/mock/workdir", _branch: "test-_branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve(),
    pullLatest: () => Promise.resolve(),
    mergeBranch: () => Promise.resolve({ conflicts: false }),
    push: () => Promise.resolve(),
    popStash: () => Promise.resolve(),
    getStatus: () => Promise.resolve({ modified: [], untracked: [], deleted: [] }),
    ...(overrides.gitService || {}),
  });

  // Create default task service mock using createPartialMock
  const taskService = createPartialMock<TaskServiceInterface>({
    getTask: () => Promise.resolve(null),
    setTaskStatus: () => Promise.resolve(),
    getTaskStatus: () => Promise.resolve(null),
    getBackendForTask: (__taskId: unknown) => Promise.resolve("markdown"),
    listTasks: () => Promise.resolve([]),
    createTask: () =>
      Promise.resolve({
        _id: "#test",
        _title: "Test Task",
        _status: "TODO",
      }),
    ...(overrides.taskService || {}),
  });

  // Create default workspace utils mock using createPartialMock
  const workspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
    isWorkspace: () => Promise.resolve(true),
    isSessionWorkspace: () => Promise.resolve(false),
    getCurrentSession: () => Promise.resolve(null),
    getSessionFromWorkspace: () => Promise.resolve(null),
    resolveWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
    ...(overrides.workspaceUtils || {}),
  });

  // Return the combined dependencies
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
export function createTaskTestDeps(__overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  const taskService = createPartialMock<TaskServiceInterface>({
    getTask: () => Promise.resolve(null),
    setTaskStatus: () => Promise.resolve(),
    getTaskStatus: () => Promise.resolve(null),
    getBackendForTask: (__taskId: unknown) => Promise.resolve("markdown"),
    listTasks: () => Promise.resolve([]),
    createTask: () =>
      Promise.resolve({
        _id: "#test",
        _title: "Test Task",
        _status: "TODO",
      }),
    ...(overrides.taskService || {}),
  });

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
export function createSessionTestDeps(_overrides: Partial<SessionDependencies> = {}
): SessionDependencies {
  const sessionDB = createPartialMock<SessionProviderInterface>({
    listSessions: () => Promise.resolve([]),
    getSession: () => Promise.resolve(null),
    getSessionByTaskId: () => Promise.resolve(null),
    addSession: () => Promise.resolve(),
    updateSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(true),
    getRepoPath: () => Promise.resolve("/mock/repo/path"),
    getSessionWorkdir: () => Promise.resolve("/mock/workdir/path"),
    ...(overrides.sessionDB || {}),
  });

  const gitService = createPartialMock<GitServiceInterface>({
    clone: () => Promise.resolve({ _workdir: "/mock/workdir", _session: "test-session" }),
    branch: () => Promise.resolve({ _workdir: "/mock/workdir", _branch: "test-_branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve(),
    pullLatest: () => Promise.resolve(),
    mergeBranch: () => Promise.resolve({ conflicts: false }),
    push: () => Promise.resolve(),
    popStash: () => Promise.resolve(),
    getStatus: () => Promise.resolve({ modified: [], untracked: [], deleted: [] }),
    ...(overrides.gitService || {}),
  });

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
export function createGitTestDeps(__overrides: Partial<GitDependencies> = {}): GitDependencies {
  const gitService = createPartialMock<GitServiceInterface>({
    clone: () => Promise.resolve({ _workdir: "/mock/workdir", _session: "test-session" }),
    branch: () => Promise.resolve({ _workdir: "/mock/workdir", _branch: "test-_branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve(),
    pullLatest: () => Promise.resolve(),
    mergeBranch: () => Promise.resolve({ conflicts: false }),
    push: () => Promise.resolve(),
    popStash: () => Promise.resolve(),
    getStatus: () => Promise.resolve({ modified: [], untracked: [], deleted: [] }),
    ...(overrides.gitService || {}),
  });

  const execAsync = () => Promise.resolve({ stdout: "", stderr: "" });
  const getSession = () =>
    Promise.resolve({
      name: "test-session",
      repoName: "test-repo",
      _taskId: "TEST_VALUE",
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

/**
 * Creates a mock repository backend for tests
 * @param overrides Partial implementation to override the defaults
 * @returns A complete mock repository backend
 */
export function createMockRepositoryBackend(_overrides: Partial<RepositoryBackend> = {}
): RepositoryBackend {
  // Use createPartialMock to handle the interface requirements
  return createPartialMock<RepositoryBackend>({
    clone: () =>
      Promise.resolve({
        _workdir: "/mock/workdir",
        _session: "test-session",
      }),
    branch: () =>
      Promise.resolve({
        _workdir: "/mock/workdir",
        _branch: "test-_branch",
      }),
    getStatus: () =>
      Promise.resolve({
        clean: true,
        _branch: "test-_branch",
      }),
    getPath: () => "/mock/repo/path",
    validate: () =>
      Promise.resolve({
        success: true,
        valid: true,
      }),
    push: () =>
      Promise.resolve({
        success: true,
      }),
    pull: () =>
      Promise.resolve({
        success: true,
      }),
    ...overrides,
  });
}

/**
 * Applies mock dependencies temporarily within a test function.
 * This allows replacing dependencies just for a specific test without
 * affecting the original dependencies.
 *
 * @template T The type of dependencies
 * @template R The return type of the test function
 * @param originalDeps The original dependencies object
 * @param mockOverrides Partial mock implementations to apply
 * @param testFn The test function to execute with mocked dependencies
 * @returns The result of the test function
 */
export function withMockedDeps<T extends Record<string, unknown>, R>(
  originalDeps: T,
  mockOverrides: Partial<T>,
  testFn: (_deps: unknown) => R
): R {
  // Create a shallow copy of the original deps
  const tempDeps = { ...originalDeps };

  // Apply overrides to the temporary dependencies
  Object.keys(mockOverrides).forEach((key) => {
    const k = key as keyof T;
    const override = mockOverrides[k];

    if (
      typeof override === "object" &&
      override !== null &&
      typeof tempDeps[k] === "object" &&
      tempDeps[k] !== null
    ) {
      // For object properties, merge with original instead of replacing
      tempDeps[k] = {
        ...tempDeps[k],
        ...override,
      } as T[typeof k];
    } else {
      // For primitive properties, replace
      tempDeps[k] = override as T[typeof k];
    }
  });

  // Run the test function with the temporary dependencies
  return testFn(tempDeps);
}

/**
 * Creates deeply nested test dependencies with type safety
 * @param partialDeps Partial nested dependencies to apply
 * @returns A complete set of deeply nested dependencies with mocks
 */
export function createDeepTestDeps(__partialDeps: Partial<DomainDependencies>): DomainDependencies {
  // Start with a base set of dependencies
  const baseDeps = createTestDeps();

  // Apply deep overrides
  return deepMergeDeps(_baseDeps, partialDeps);
}

/**
 * Helper function to deep merge dependencies
 * @param target The target object to merge into
 * @param source The source object with overrides
 * @returns The merged object
 */
function deepMergeDeps<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const output = { ...target };

  Object.keys(source).forEach((key) => {
    const k = key as keyof T;
    const sourceValue = source[k];
    const targetValue = target[k];

    if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // For object properties, recursively merge
      output[k] = deepMergeDeps(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[typeof k];
    } else {
      // For other properties, replace
      output[k] = sourceValue as T[typeof k];
    }
  });

  return output;
}

/**
 * Creates partial test dependencies with specific overrides for targeted testing
 * @param overrides Specific dependency overrides to apply
 * @returns A partial set of domain dependencies for testing
 */
export function createPartialTestDeps(_overrides: Partial<DomainDependencies> = {}
): Partial<DomainDependencies> {
  return overrides;
}
