/**
 * Session CLI Commands Tests
 * 
 * Main session test file - now imports from modularized test files
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rmdir } from "fs/promises";
import { existsSync } from "fs";
import { createMock, setupTestMocks } from "../../../src/utils/test-utils/mocking";
import type { SessionRecord, SessionProviderInterface } from "../../../src/domain/session";
import type { GitServiceInterface } from "../../../src/domain/git";

// Import modularized test files
import "./session-test-utilities";
import "./session-directory.test";
import "./session-update.test";
import "./session-remaining.test";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session CLI Commands", () => {
  let mockSessionDB: any;
  let mockSessions: any[];
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), "test-tmp", "session-cli-test");

    // Create test data for all session tests
    mockSessions = [
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

    mockSessionDB = {
      findAll: createMock().mockResolvedValue(mockSessions),
      findByName: createMock().mockImplementation((name: string) => {
        return Promise.resolve(mockSessions.find((s) => s.session === name) || null);
      }),
      findByTaskId: createMock().mockImplementation((taskId: string) => {
        return Promise.resolve(mockSessions.find((s) => s.taskId === taskId) || null);
      }),
      findByRepoPath: createMock().mockImplementation((repoPath: string) => {
        return Promise.resolve(mockSessions.find((s) => s.repoPath === repoPath) || null);
      }),
      save: createMock().mockResolvedValue(undefined),
      getSessionByTaskId: createMock().mockImplementation((taskId: string) => {
        return Promise.resolve(mockSessions.find((s) => s.taskId === taskId) || null);
      }),
      getSession: createMock().mockImplementation((name: string) => {
        return Promise.resolve(mockSessions.find((s) => s.session === name) || null);
      }),
    } as unknown as SessionProviderInterface;
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rmdir(tempDir, { recursive: true });
    }
  });

  // Main test suite placeholder - actual tests are in modularized files
  test("modularized test suite initialization", () => {
    expect(mockSessions).toHaveLength(3);
    expect(mockSessions[0].session).toBe("004");
    expect(mockSessions[1].session).toBe("task#160");
    expect(mockSessions[2].session).toBe("task#170");
  });
});
