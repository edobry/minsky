/**
 * Dependency injection utilities for tests
 * This module provides functions to create test dependencies with sensible defaults
 */
import { createMock } from "./mocking";
import type { SessionProviderInterface } from "../../domain/session";
import type { GitServiceInterface } from "../../domain/git";
import type { TaskService } from "../../domain/tasks";

/**
 * Basic domain dependencies structure for common domain functions
 */
export interface DomainDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  taskService: any; // Using any for now, will be replaced with TaskServiceInterface
  workspaceUtils?: any; // Using any for now, will be replaced with WorkspaceUtilsInterface
  [key: string]: any; // Allow additional properties
}

/**
 * Creates test dependencies with mock implementations
 * @param overrides Optional partial implementation to override the default mocks
 * @returns A complete set of domain dependencies for testing
 */
export function createTestDeps(overrides: Partial<DomainDependencies> = {}): DomainDependencies {
  // Create default session provider mock
  const sessionDB: SessionProviderInterface = {
    listSessions: createMock(() => Promise.resolve([])),
    getSession: createMock(() => Promise.resolve(null)),
    getSessionByTaskId: createMock(() => Promise.resolve(null)),
    addSession: createMock(() => Promise.resolve()),
    updateSession: createMock(() => Promise.resolve()),
    deleteSession: createMock(() => Promise.resolve(true)),
    getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path")),
    ...overrides.sessionDB
  };

  // Create default git service mock
  const gitService: GitServiceInterface = {
    clone: createMock(() => Promise.resolve({ workdir: "/mock/workdir", session: "mock-session" })),
    branch: createMock(() => Promise.resolve({ workdir: "/mock/workdir", branch: "mock-branch" })),
    pr: createMock(() => Promise.resolve({ markdown: "mock-pr" })),
    getStatus: createMock(() => Promise.resolve({ modified: [], untracked: [], deleted: [] })),
    stageAll: createMock(() => Promise.resolve()),
    stageModified: createMock(() => Promise.resolve()),
    commit: createMock(() => Promise.resolve("mock-commit-hash")),
    stashChanges: createMock(() => Promise.resolve({ workdir: "/mock/workdir", stashed: false })),
    popStash: createMock(() => Promise.resolve({ workdir: "/mock/workdir", stashed: false })),
    pullLatest: createMock(() => Promise.resolve({ workdir: "/mock/workdir", updated: false })),
    mergeBranch: createMock(() => Promise.resolve({ workdir: "/mock/workdir", merged: false })),
    push: createMock(() => Promise.resolve({ workdir: "/mock/workdir", pushed: false })),
    preparePr: createMock(() => Promise.resolve({ prBranch: "mock-pr-branch", baseBranch: "main" })),
    mergePr: createMock(() => Promise.resolve({
      prBranch: "mock-pr-branch",
      baseBranch: "main",
      commitHash: "mock-commit-hash",
      mergeDate: new Date().toISOString(),
      mergedBy: "mock-user"
    })),
    fetchDefaultBranch: createMock(() => Promise.resolve("main")),
    execInRepository: createMock(() => Promise.resolve("")),
    getSessionRecord: createMock(() => Promise.resolve(undefined)),
    getSessionWorkdir: createMock(() => "/mock/workdir"),
    ...overrides.gitService
  };

  // Create default task service mock (minimal implementation)
  const taskService = {
    getTask: createMock(() => Promise.resolve(null)),
    setTaskStatus: createMock(() => Promise.resolve()),
    getTaskStatus: createMock(() => Promise.resolve(null)),
    getBackendForTask: createMock(() => Promise.resolve({
      setTaskMetadata: createMock(() => Promise.resolve())
    })),
    ...overrides.taskService
  };

  // Create default workspace utils mock
  const workspaceUtils = {
    getCurrentSession: createMock(() => Promise.resolve(null)),
    isSessionWorkspace: createMock(() => Promise.resolve(false)),
    ...overrides.workspaceUtils
  };

  // Return the combined dependencies
  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    ...overrides
  };
}

/**
 * Creates partial test dependencies with specific overrides for targeted testing
 * @param overrides Specific dependency overrides to apply
 * @returns A partial set of domain dependencies for testing
 */
export function createPartialTestDeps(overrides: Partial<DomainDependencies> = {}): Partial<DomainDependencies> {
  return overrides;
} 
