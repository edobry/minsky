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
    // Add missing sessions that the update tests expect
    {
      session: "test-existing-session",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#168",
      branch: "test-existing-session",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/test-existing-session",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "task#42",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#42",
      branch: "task#42",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/task#42",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "missing-workspace-session",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#999",
      branch: "missing-workspace-session",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/missing-workspace-session",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "dirty-session",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "#888",
      branch: "dirty-session",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/dirty-session",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
  ];

  const mockSessionDB = {
    listSessions: createMock(),
    getSession: createMock(),
    getSessionByTaskId: createMock(),
    addSession: createMock(),
    updateSession: createMock(),
    deleteSession: createMock(),
    getRepoPath: createMock(),
    getSessionWorkdir: createMock(),
  } as unknown as SessionProviderInterface;

  // Set up mock implementations manually to avoid type issues
  (mockSessionDB.listSessions as any).mockResolvedValue(mockSessions);
  (mockSessionDB.getSession as any).mockImplementation((name: string) => {
    return Promise.resolve(mockSessions.find((s) => s.session === name) || null);
  });
  (mockSessionDB.getSessionByTaskId as any).mockImplementation((taskId: string) => {
    return Promise.resolve(mockSessions.find((s) => s.taskId === taskId) || null);
  });
  (mockSessionDB.getRepoPath as any).mockImplementation((record: any) => {
    return Promise.resolve(record.repoPath || "/default/path");
  });
  (mockSessionDB.addSession as any).mockResolvedValue(undefined);
  (mockSessionDB.updateSession as any).mockResolvedValue(undefined);
  (mockSessionDB.deleteSession as any).mockResolvedValue(true);
  (mockSessionDB.getSessionWorkdir as any).mockImplementation((sessionName: string) => {
    const session = mockSessions.find((s) => s.session === sessionName);
    return Promise.resolve(session?.repoPath || "/default/workdir");
  });

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
    getCurrentBranch: createMock().mockResolvedValue("main"),
    getRemoteUrl: createMock().mockResolvedValue("https://github.com/edobry/minsky"),
    getRepoPath: createMock().mockResolvedValue("/Users/edobry/Projects/minsky"),
    clone: createMock().mockResolvedValue(undefined),
    checkout: createMock().mockResolvedValue(undefined),
    createBranch: createMock().mockResolvedValue(undefined),
    push: createMock().mockResolvedValue(undefined),
    pull: createMock().mockResolvedValue(undefined),
    merge: createMock().mockResolvedValue(undefined),
    getStatus: createMock().mockResolvedValue({ hasChanges: false, changes: [] }),
    add: createMock().mockResolvedValue(undefined),
    commit: createMock().mockResolvedValue(undefined),
    reset: createMock().mockResolvedValue(undefined),
    stash: createMock().mockResolvedValue(undefined),
    stashPop: createMock().mockResolvedValue(undefined),
    getCommitHash: createMock().mockResolvedValue("abc123"),
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
