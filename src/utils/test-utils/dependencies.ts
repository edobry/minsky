/**
 * Dependency injection utilities for tests
 * This module provides functions to create test dependencies with sensible defaults
 */
import { createMock, createPartialMock } from "./mocking";
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
  [key: string]: any; // Allow additional properties
}

/**
 * Task-specific dependencies interface
 */
export interface TaskDependencies {
  taskService: TaskServiceInterface;
  resolveWorkspacePath: (options?: any) => Promise<string>;
  resolveRepoPath: (options?: any) => Promise<string>;
  [key: string]: any;
}

/**
 * Session-specific dependencies interface
 */
export interface SessionDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  [key: string]: any;
}

/**
 * Git-specific dependencies interface
 */
export interface GitDependencies {
  gitService: GitServiceInterface;
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
  [key: string]: any;
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
    listSessions: createMock(() => Promise.resolve([])),
    getSession: createMock(() => Promise.resolve(null)),
    getSessionByTaskId: createMock(() => Promise.resolve(null)),
    addSession: createMock(() => Promise.resolve()),
    updateSession: createMock(() => Promise.resolve()),
    deleteSession: createMock(() => Promise.resolve(true)),
    getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path")),
    ...(overrides.sessionDB || {})
  });

  // Create default git service mock using createPartialMock
  const gitService = createPartialMock<GitServiceInterface>({
    // Use specific implementation signatures that match the interface
    createPR: createMock(() => Promise.resolve({ success: true })),
    push: createMock(() => Promise.resolve()),
    commit: createMock(() => Promise.resolve({ success: true })),
    repoStatus: createMock(() => Promise.resolve({ success: true, clean: true })),
    pr: createMock(() => Promise.resolve({ markdown: "# PR Description" })),
    getConfig: createMock(() =>
      Promise.resolve({
        username: "test-user",
        email: "test@example.com",
      })
    ),
    updateTaskStatus: createMock(() => Promise.resolve({ success: true })),
    ...(overrides.gitService || {})
  });

  // Create default task service mock using createPartialMock
  const taskService = createPartialMock<TaskServiceInterface>({
    getTask: createMock(() => Promise.resolve(null)),
    setTaskStatus: createMock(() => Promise.resolve()),
    getTaskStatus: createMock(() => Promise.resolve(null)),
    getBackendForTask: createMock((taskId: string) => Promise.resolve("markdown")),
    listTasks: createMock(() => Promise.resolve([])),
    createTask: createMock(() =>
      Promise.resolve({
        id: "#test",
        title: "Test Task",
        status: "TODO",
      })
    ),
    ...(overrides.taskService || {})
  });

  // Create default workspace utils mock using createPartialMock
  const workspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
    getCurrentSession: createMock(() => Promise.resolve(null)),
    isSessionWorkspace: createMock(() => Promise.resolve(false)),
    getSessionForWorkspace: createMock(() => Promise.resolve(null)),
    ...(overrides.workspaceUtils || {})
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
    getTask: createMock(() => Promise.resolve(null)),
    setTaskStatus: createMock(() => Promise.resolve()),
    getTaskStatus: createMock(() => Promise.resolve(null)),
    getBackendForTask: createMock((taskId: string) => Promise.resolve("markdown")),
    listTasks: createMock(() => Promise.resolve([])),
    createTask: createMock(() =>
      Promise.resolve({
        id: "#test",
        title: "Test Task",
        status: "TODO",
      })
    ),
    ...(overrides.taskService || {})
  });

  const resolveWorkspacePath = createMock(() => Promise.resolve("/mock/workspace/path"));
  const resolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));

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
    listSessions: createMock(() => Promise.resolve([])),
    getSession: createMock(() => Promise.resolve(null)),
    getSessionByTaskId: createMock(() => Promise.resolve(null)),
    addSession: createMock(() => Promise.resolve()),
    updateSession: createMock(() => Promise.resolve()),
    deleteSession: createMock(() => Promise.resolve(true)),
    getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path")),
    ...(overrides.sessionDB || {})
  });

  const gitService = createPartialMock<GitServiceInterface>({
    createPR: createMock(() => Promise.resolve({ success: true })),
    push: createMock(() => Promise.resolve()),
    commit: createMock(() => Promise.resolve({ success: true })),
    repoStatus: createMock(() => Promise.resolve({ success: true, clean: true })),
    pr: createMock(() => Promise.resolve({ markdown: "# PR Description" })),
    getConfig: createMock(() =>
      Promise.resolve({
        username: "test-user",
        email: "test@example.com",
      })
    ),
    updateTaskStatus: createMock(() => Promise.resolve({ success: true })),
    ...(overrides.gitService || {})
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
    createPR: createMock(() => Promise.resolve({ success: true })),
    push: createMock(() => Promise.resolve()),
    commit: createMock(() => Promise.resolve({ success: true })),
    repoStatus: createMock(() => Promise.resolve({ success: true, clean: true })),
    pr: createMock(() => Promise.resolve({ markdown: "# PR Description" })),
    getConfig: createMock(() =>
      Promise.resolve({
        username: "test-user",
        email: "test@example.com",
      })
    ),
    updateTaskStatus: createMock(() => Promise.resolve({ success: true })),
    ...(overrides.gitService || {})
  });

  const execAsync = createMock(() => Promise.resolve({ stdout: "", stderr: "" }));
  const getSession = createMock(() =>
    Promise.resolve({
      name: "test-session",
      repoName: "test-repo",
      taskId: "123",
    })
  );
  const getSessionWorkdir = createMock(() => "/mock/session/workdir");

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
    clone: createMock(() =>
      Promise.resolve({
        workdir: "/mock/workdir",
        session: "test-session",
      })
    ),
    branch: createMock(() =>
      Promise.resolve({
        workdir: "/mock/workdir",
        branch: "test-branch",
      })
    ),
    getStatus: createMock(() =>
      Promise.resolve({
        clean: true,
        branch: "test-branch",
      })
    ),
    getPath: createMock(() => "/mock/repo/path"),
    validate: createMock(() =>
      Promise.resolve({
        success: true,
        valid: true,
      })
    ),
    push: createMock(() =>
      Promise.resolve({
        success: true,
      })
    ),
    pull: createMock(() =>
      Promise.resolve({
        success: true,
      })
    ),
    ...overrides
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
export function withMockedDeps<T extends Record<string, any>, R>(
  originalDeps: T,
  mockOverrides: Partial<T>,
  testFn: (deps: T) => R
): R {
  // Create a shallow copy of the original deps
  const tempDeps = { ...originalDeps };

  // Apply overrides to the temporary dependencies
  Object.keys(mockOverrides).forEach((key) => {
    const k = key as keyof T;
    const override = mockOverrides[k];
    
    if (typeof override === "object" && override !== null && typeof tempDeps[k] === "object" && tempDeps[k] !== null) {
      // For object properties, merge with original instead of replacing
      tempDeps[k] = {
        ...tempDeps[k],
        ...override,
      };
    } else {
      // For primitive properties, replace
      tempDeps[k] = override as any;
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
export function createDeepTestDeps(
  partialDeps: Partial<DomainDependencies>
): DomainDependencies {
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
function deepMergeDeps<T extends Record<string, any>>(target: T, source: Partial<T>): T {
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
        targetValue,
        sourceValue as any
      ) as any;
    } else {
      // For other properties, replace
      output[k] = sourceValue as any;
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
