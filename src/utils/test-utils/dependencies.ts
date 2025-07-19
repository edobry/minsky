const _TEST_VALUE = 123;

/**
 * Dependency injection utilities for tests
 * This module provides functions to create test dependencies with sensible defaults
 */
import { createPartialMock } from "./mocking";
import type { SessionProviderInterface, SessionRecord } from "../../domain/session";
import type { GitServiceInterface } from "../../domain/git";
import type { TaskServiceInterface, Task, TaskListOptions, CreateTaskOptions } from "../../domain/tasks";
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
    clone: () => Promise.resolve({ workdir: "/mock/workdir", session: "test-session" }),
    branch: () => Promise.resolve({ workdir: "/mock/workdir", branch: "test-branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve({ workdir: "/mock/workdir", stashed: true }),
    pullLatest: () => Promise.resolve({ workdir: "/mock/workdir", updated: true }),
    mergeBranch: () => Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false }),
    push: () => Promise.resolve({ workdir: "/mock/workdir", pushed: true }),
    popStash: () => Promise.resolve({ workdir: "/mock/workdir", stashed: false }),
    getStatus: () => Promise.resolve({ modified: [], untracked: [], deleted: [] }),
    ...(overrides.gitService || {}),
  });

  // Create default task service mock using createPartialMock
  const taskService = createPartialMock<TaskServiceInterface>({
    getTask: () => Promise.resolve(null),
    setTaskStatus: () => Promise.resolve(),
    getTaskStatus: () => Promise.resolve(undefined),
    getBackendForTask: (taskId: unknown) => Promise.resolve("markdown"),
    listTasks: () => Promise.resolve([]),
    createTask: () =>
      Promise.resolve({
        id: "#test",
        title: "Test Task",
        status: "TODO",
      }),
    ...(overrides.taskService || {}),
  });

  // Create default workspace utils mock using createPartialMock
  const workspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
    isWorkspace: () => Promise.resolve(true),
    isSessionWorkspace: () => false,
    getCurrentSession: () => Promise.resolve(undefined),
    getSessionFromWorkspace: () => Promise.resolve(undefined),
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
export function createTaskTestDeps(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  const taskService = createPartialMock<TaskServiceInterface>({
    getTask: () => Promise.resolve(null),
    setTaskStatus: () => Promise.resolve(),
    getTaskStatus: () => Promise.resolve(undefined),
    getBackendForTask: (taskId: unknown) => Promise.resolve("markdown"),
    listTasks: () => Promise.resolve([]),
    createTask: () =>
      Promise.resolve({
        id: "#test",
        title: "Test Task",
        status: "TODO",
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
export function createSessionTestDeps(
  overrides: Partial<SessionDependencies> = {}
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
    clone: () => Promise.resolve({ workdir: "/mock/workdir", session: "test-session" }),
    branch: () => Promise.resolve({ workdir: "/mock/workdir", branch: "test-_branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve({ workdir: "/mock/workdir", stashed: true }),
    pullLatest: () => Promise.resolve({ workdir: "/mock/workdir", updated: true }),
    mergeBranch: () => Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false }),
    push: () => Promise.resolve({ workdir: "/mock/workdir", pushed: true }),
    popStash: () => Promise.resolve({ workdir: "/mock/workdir", stashed: false }),
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
export function createGitTestDeps(overrides: Partial<GitDependencies> = {}): GitDependencies {
  const gitService = createPartialMock<GitServiceInterface>({
    clone: () => Promise.resolve({ workdir: "/mock/workdir", session: "test-session" }),
    branch: () => Promise.resolve({ workdir: "/mock/workdir", branch: "test-_branch" }),
    execInRepository: () => Promise.resolve("mock output"),
    getSessionWorkdir: () => "/mock/session/workdir",
    stashChanges: () => Promise.resolve({ workdir: "/mock/workdir", stashed: true }),
    pullLatest: () => Promise.resolve({ workdir: "/mock/workdir", updated: true }),
    mergeBranch: () => Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false }),
    push: () => Promise.resolve({ workdir: "/mock/workdir", pushed: true }),
    popStash: () => Promise.resolve({ workdir: "/mock/workdir", stashed: false }),
    getStatus: () => Promise.resolve({ modified: [], untracked: [], deleted: [] }),
    ...(overrides.gitService || {}),
  });

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

/**
 * Creates a mock repository backend for tests
 * @param overrides Partial implementation to override the defaults
 * @returns A complete mock repository backend
 */
export function createMockRepositoryBackend(
  overrides: Partial<RepositoryBackend> = {}
): RepositoryBackend {
  // Use createPartialMock to handle the interface requirements
  return createPartialMock<RepositoryBackend>({
    clone: () =>
      Promise.resolve({
        workdir: "/mock/workdir",
        session: "test-session",
      }),
    branch: () =>
      Promise.resolve({
        workdir: "/mock/workdir",
        branch: "test-_branch",
      }),
    getStatus: () =>
      Promise.resolve({
        clean: true,
        branch: "test-_branch",
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
  testFn: (deps: unknown) => R
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
export function createDeepTestDeps(partialDeps: Partial<DomainDependencies>): DomainDependencies {
  // Start with a base set of dependencies
  const baseDeps = createTestDeps();

  // Apply deep overrides
  return deepMergeDeps(baseDeps, partialDeps);
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
export function createPartialTestDeps(
  overrides: Partial<DomainDependencies> = {}
): Partial<DomainDependencies> {
  return overrides;
}

/**
 * Individual Service Mock Factory Functions
 * These factories eliminate duplication by providing centralized mock implementations
 * that can be used across multiple test files.
 */

/**
 * Options for configuring SessionProviderInterface mock behavior
 */
export interface MockSessionProviderOptions {
  sessions?: SessionRecord[];
  getSession?: (sessionName: string) => Promise<SessionRecord | null>;
  getSessionByTaskId?: (taskId: string) => Promise<SessionRecord | null>;
  addSession?: () => Promise<void>;
  updateSession?: () => Promise<void>;
  deleteSession?: () => Promise<boolean>;
  getRepoPath?: () => Promise<string>;
  getSessionWorkdir?: () => Promise<string>;
  listSessions?: () => Promise<SessionRecord[]>;
}

/**
 * Creates a mock SessionProviderInterface with comprehensive interface coverage
 * Eliminates duplication across test files by providing a centralized implementation
 *
 * @param options Configuration options for mock behavior
 * @returns A complete mock SessionProviderInterface
 */
export function createMockSessionProvider(
  options: MockSessionProviderOptions = {}
): SessionProviderInterface {
  const { sessions = [] } = options;

  const mockProvider = createPartialMock<SessionProviderInterface>({
    listSessions: options.listSessions || (() => Promise.resolve(sessions)),

    getSession: options.getSession || ((sessionName: string) => {
      const session = sessions.find((s) => s.session === sessionName);
      return Promise.resolve(session || null);
    }),

    getSessionByTaskId: options.getSessionByTaskId || ((taskId: string) => {
      const session = sessions.find((s) => s.taskId === taskId);
      return Promise.resolve(session || null);
    }),

    addSession: options.addSession || (() => Promise.resolve()),
    updateSession: options.updateSession || (() => Promise.resolve()),
    deleteSession: options.deleteSession || (() => Promise.resolve(true)),
    getRepoPath: options.getRepoPath || (() => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: options.getSessionWorkdir || (() => Promise.resolve("/mock/session/workdir")),
  });

  return mockProvider;
}

/**
 * Options for configuring GitServiceInterface mock behavior
 */
export interface MockGitServiceOptions {
  branchExists?: boolean;
  execInRepository?: (workdir: string, command: string) => Promise<string>;
  clone?: () => Promise<{ workdir: string; session: string }>;
  branch?: () => Promise<{ workdir: string; branch: string }>;
  getSessionWorkdir?: () => string;
  stashChanges?: () => Promise<{ workdir: string; stashed: boolean }>;
  pullLatest?: () => Promise<{ workdir: string; updated: boolean }>;
  mergeBranch?: () => Promise<{ workdir: string; merged: boolean; conflicts: boolean }>;
  push?: () => Promise<{ workdir: string; pushed: boolean }>;
  popStash?: () => Promise<{ workdir: string; stashed: boolean }>;
  getStatus?: () => Promise<{ modified: string[]; untracked: string[]; deleted: string[] }>;
}

/**
 * Creates a mock GitServiceInterface with all required methods
 * Provides realistic mock responses and supports command-specific overrides
 *
 * @param options Configuration options for mock behavior
 * @returns A complete mock GitServiceInterface
 */
export function createMockGitService(
  options: MockGitServiceOptions = {}
): GitServiceInterface {
  const { branchExists = true } = options;
  let gitCallCount = 0;

  const mockGitService = createPartialMock<GitServiceInterface>({
    execInRepository: options.execInRepository || ((workdir: string, command: string) => {
      gitCallCount++;
      if (command.includes("show-ref") && command.includes("pr/")) {
        return Promise.resolve(branchExists ? "ref-exists" : "not-exists");
      }
      if (command.includes("ls-remote") && command.includes("pr/")) {
        return Promise.resolve(branchExists ? "remote-ref-exists" : "");
      }
      return Promise.resolve("mock git output");
    }),

    clone: options.clone || (() => Promise.resolve({ workdir: "/mock/workdir", session: "test-session" })),

    branch: options.branch || (() => Promise.resolve({ workdir: "/mock/workdir", branch: "test-branch" })),

    getSessionWorkdir: options.getSessionWorkdir || (() => "/mock/session/workdir"),

    stashChanges: options.stashChanges || (() => Promise.resolve({ workdir: "/mock/workdir", stashed: true })),

    pullLatest: options.pullLatest || (() => Promise.resolve({ workdir: "/mock/workdir", updated: true })),

    mergeBranch: options.mergeBranch || (() => Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false })),

    push: options.push || (() => Promise.resolve({ workdir: "/mock/workdir", pushed: true })),

    popStash: options.popStash || (() => Promise.resolve({ workdir: "/mock/workdir", stashed: false })),

    getStatus: options.getStatus || (() => Promise.resolve({ modified: [], untracked: [], deleted: [] })),
  });

  // Add additional utility methods that some tests expect
  (mockGitService as any).getGitCallCount = () => gitCallCount;
  (mockGitService as any).resetGitCallCount = () => { gitCallCount = 0; };

  return mockGitService;
}

/**
 * Options for configuring TaskServiceInterface mock behavior
 */
export interface MockTaskServiceOptions {
  mockGetTask?: (taskId: string) => Promise<Task | null>;
  backends?: string[];
  currentBackend?: string;
  listTasks?: (options?: TaskListOptions) => Promise<Task[]>;
  getTaskStatus?: (taskId: string) => Promise<string | undefined>;
  setTaskStatus?: (taskId: string, status: string) => Promise<void>;
  createTask?: (specPath: string, options?: CreateTaskOptions) => Promise<Task>;
  deleteTask?: (taskId: string) => Promise<boolean>;
  getWorkspacePath?: () => string;
  createTaskFromTitleAndDescription?: (title: string, description: string, options?: CreateTaskOptions) => Promise<Task>;
  getBackendForTask?: (taskId: string) => Promise<string>;
}

/**
 * Creates a mock TaskServiceInterface with standard implementations
 * Provides consistent task data responses and supports task state management
 *
 * @param options Configuration options for mock behavior
 * @returns A complete mock TaskServiceInterface
 */
export function createMockTaskService(
  options: MockTaskServiceOptions = {}
): TaskServiceInterface {
  const mockTaskService = createPartialMock<TaskServiceInterface>({
    getTask: options.mockGetTask || (() => Promise.resolve(null)),

    listTasks: options.listTasks || (() => Promise.resolve([])),

    getTaskStatus: options.getTaskStatus || (() => Promise.resolve(undefined)),

    setTaskStatus: options.setTaskStatus || (() => Promise.resolve()),

    createTask: options.createTask || ((_specPath: string, _options?: CreateTaskOptions) =>
      Promise.resolve({
        id: "#test",
        title: "Test Task",
        status: "TODO",
      })
    ),

    deleteTask: options.deleteTask || (() => Promise.resolve(false)),

    getBackendForTask: options.getBackendForTask || (() => Promise.resolve("markdown")),

    createTaskFromTitleAndDescription: options.createTaskFromTitleAndDescription || ((title: string, description: string, options?: CreateTaskOptions) =>
      Promise.resolve({
        id: "#test-from-title",
        title: "Test Task",
        status: "TODO",
      })
    ),
  });

  // Add additional properties that some tests expect
  (mockTaskService as any).backends = options.backends || [];
  (mockTaskService as any).currentBackend = options.currentBackend || "test";
  (mockTaskService as any).getWorkspacePath = options.getWorkspacePath || (() => "/mock/workspace/path");

  return mockTaskService;
}
