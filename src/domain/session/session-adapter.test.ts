/**
 * Test suite for SessionAdapter class
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionAdapter } from "./session-adapter";
import * as fs from "fs";
import * as path from "path";

// Type helper for tests (only used for type checking, not at runtime)
type ExtendedExpect = {
  toHaveProperty(property: string, value?: any): void;
  toHaveLength(length: number): void;
  toThrow(message?: string | RegExp | Error): void;
  not: {
    toBeNull(): void;
    toHaveProperty(property: string, value?: any): void;
  };
};

describe("SessionAdapter", () => {
  // Create a temp test directory
  const testDir = `/tmp/minsky-session-test-${Date.now()}`;
  const dbPath = path.join(testDir, "test-session-db.json");

  // Helper to create a test adapter
  const createTestAdapter = () => {
    return new SessionAdapter(dbPath);
  };

  // Set up and tear down test environment
  beforeEach(() => {
    // Create test directory
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    
    try {
      fs.rmdirSync(testDir, { recursive: true });
    } catch (error) {
      console.error("Error cleaning up test directory:", error);
    }
  });

  it("should initialize with empty sessions", async () => {
    const adapter = createTestAdapter();
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should add and retrieve a session", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const retrievedSession = await adapter.getSession("test-session");
    
    (expect(retrievedSession) as unknown as ExtendedExpect).not.toBeNull();
    expect(retrievedSession?.session).toBe("test-session");
    expect(retrievedSession?.taskId).toBe("#123");
  });

  it("should retrieve a session by task ID", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const retrievedSession = await adapter.getSessionByTaskId("123");
    
    (expect(retrievedSession) as unknown as ExtendedExpect).not.toBeNull();
    expect(retrievedSession?.session).toBe("test-session");
  });

  it("should update a session", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    await adapter.updateSession("test-session", { branch: "updated-branch" });
    
    const retrievedSession = await adapter.getSession("test-session");
    expect(retrievedSession?.branch).toBe("updated-branch");
  });

  it("should delete a session", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const result = await adapter.deleteSession("test-session");
    
    expect(result).toBe(true);
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should return false when deleting a non-existent session", async () => {
    const adapter = createTestAdapter();
    const result = await adapter.deleteSession("non-existent");
    
    expect(result).toBe(false);
  });

  it("should get repository path for a session", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const repoPath = await adapter.getRepoPath(testSession);
    
    expect(repoPath).toContain("test-repo/sessions/test-session");
  });

  it("should get working directory for a session", async () => {
    const adapter = createTestAdapter();
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const workdir = await adapter.getSessionWorkdir("test-session");
    
    (expect(workdir) as unknown as ExtendedExpect).not.toBeNull();
    expect(workdir).toContain("test-repo/sessions/test-session");
  });
}); 
