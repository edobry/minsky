/**
 * Session Test Utilities
 *
 * Common mocks, test data, and setup functions for session command tests
 */

import { join } from "path";
// Use mock.module() to mock filesystem operations
// import { mkdir, rmdir } from "fs/promises";
// Use mock.module() to mock filesystem operations
// import { existsSync } from "fs";
import { mock } from "bun:test";
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
  const tempDir = "/mock/test-tmp/session-cli-test";

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
      taskId: "md#160", // FORMAT MIGRATION: Updated to qualified format
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
      taskId: "md#170", // FORMAT MIGRATION: Updated to qualified format
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
      taskId: "md#168", // FORMAT MIGRATION: Updated to qualified format
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
      taskId: "md#42", // FORMAT MIGRATION: Updated to qualified format
      branch: "task#42",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/task#42",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "task#236",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "md#236", // FORMAT MIGRATION: Updated to qualified format
      branch: "task#236",
      repoPath: "/Users/edobry/.local/state/minsky/sessions/task#236",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    },
    {
      session: "missing-workspace-session",
      repoName: "local-minsky",
      repoUrl: "https://github.com/edobry/minsky",
      createdAt: "2024-01-01T00:00:00.000Z",
      taskId: "md#999", // FORMAT MIGRATION: Updated to qualified format
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
      taskId: "md#888", // FORMAT MIGRATION: Updated to qualified format
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
  } as SessionProviderInterface;

  // Set up mock implementations manually to avoid type issues
  (mockSessionDB.listSessions as any) = mock(() => Promise.resolve(mockSessions));
  (mockSessionDB.getSession as any) = mock((name: string) => {
    return Promise.resolve(mockSessions.find((s) => s.session === name) || null);
  });
  (mockSessionDB.getSessionByTaskId as any) = mock((taskId: string) => {
    return Promise.resolve(mockSessions.find((s) => s.taskId === taskId) || null);
  });
  (mockSessionDB.getRepoPath as any) = mock((record: any) => {
    return Promise.resolve(record.repoPath || "/default/path");
  });
  (mockSessionDB.addSession as any) = mock(() => Promise.resolve(undefined));
  (mockSessionDB.updateSession as any) = mock(() => Promise.resolve(undefined));
  (mockSessionDB.deleteSession as any) = mock(() => Promise.resolve(true));
  (mockSessionDB.getSessionWorkdir as any) = mock((sessionName: string) => {
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
  // Mock cleanup - in real tests, use dependency injection to provide filesystem mock
  // This avoids real filesystem operations that can cause race conditions
  console.log(`Mock cleanup for directory: ${tempDir}`);
}

// GitService mock functionality moved to centralized utilities:
// Use createMockGitService from '../../../src/utils/test-utils/dependencies'
// This provides a complete, maintained mock with all interface methods.

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
