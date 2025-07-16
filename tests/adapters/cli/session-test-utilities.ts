/**
 * Session Test Utilities
 * 
 * Common mocks, test data, and setup functions for session command tests
 */

import { join } from "path";
import { mkdir, rmdir } from "fs/promises";
import { existsSync } from "fs";
import { createMock, setupTestMocks } from "../../../src/utils/test-utils/mocking";
import { withDirectoryIsolation } from "../../../src/utils/test-utils/cleanup-patterns";
import type { SessionRecord, SessionProviderInterface } from "../../../src/domain/session";
import type { GitServiceInterface } from "../../../src/domain/git";

// Set up automatic mock cleanup
setupTestMocks();

export interface SessionTestData {
  mockSessionDB: any;
  mockSessions: any[];
  tempDir: string;
}

export function createSessionTestData(): SessionTestData {
  const tempDir = join(process.cwd(), "test-tmp", "session-cli-test");

  // Create test data for all session tests
  const mockSessions = [
    {
      session: "004",
      repoName: "local/minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: null, // Session with no task ID
      branch: "004",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/004",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "task#160",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#160", // Session with task ID
      branch: "task#160",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/task#160",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "task#170",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#170", // Session with task ID
      branch: "task#170",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/task#170",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
  ];

  const mockSessionDB = {
    findAll: jest.fn().mockResolvedValue(mockSessions),
    findByName: jest.fn().mockImplementation((name: string) => {
      return Promise.resolve(mockSessions.find((s) => s.session === name) || null);
    }),
    findByTaskId: jest.fn().mockImplementation((taskId: string) => {
      return Promise.resolve(mockSessions.find((s) => s.taskId === taskId) || null);
    }),
    findByRepoPath: jest.fn().mockImplementation((repoPath: string) => {
      return Promise.resolve(mockSessions.find((s) => s.repoPath === repoPath) || null);
    }),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as SessionProviderInterface;

  return {
    mockSessionDB,
    mockSessions,
    tempDir,
  };
}

export async function cleanupSessionTestData(tempDir: string): Promise<void> {
  if (existsSync(tempDir)) {
    await rmdir(tempDir, { recursive: true });
  }
}

export function createGitServiceMock(): GitServiceInterface {
  return {
    getCurrentBranch: jest.fn().mockResolvedValue("main"),
    getRemoteUrl: jest.fn().mockResolvedValue("https://github.com/edobry/minsky"),
    getRepoPath: jest.fn().mockResolvedValue("/Users/edobry/Projects/minsky"),
    clone: jest.fn().mockResolvedValue(undefined),
    checkout: jest.fn().mockResolvedValue(undefined),
    createBranch: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    pull: jest.fn().mockResolvedValue(undefined),
    merge: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn().mockResolvedValue({ hasChanges: false, changes: [] }),
    add: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    stash: jest.fn().mockResolvedValue(undefined),
    stashPop: jest.fn().mockResolvedValue(undefined),
    getCommitHash: jest.fn().mockResolvedValue("abc123"),
  } as unknown as GitServiceInterface;
}

// Helper function to create session records for testing
export function createSessionRecord(overrides?: any): any {
  return {
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo",
    createdAt: new Date().toISOString(),
    taskId: undefined,
    branch: "main",
    repoPath: "/tmp/test-repo",
    backendType: "local",
    remote: { authMethod: "ssh", depth: 1 },
    ...overrides,
  };
} 
