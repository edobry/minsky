/**
 * Test suite for SessionAdapter class
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SessionAdapter } from "./session-adapter";
import { createMockFileSystem, setupTestMocks, mockModule } from "../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("SessionAdapter", () => {
  let mockFS: ReturnType<typeof createMockFileSystem>;
  const dbPath = "/test/session-db.json";

  beforeEach(() => {
    // Create fresh mock filesystem for each test
    mockFS = createMockFileSystem({
      "/test": "", // Directory marker
    });

    // Mock fs module using the existing utility
    mockModule("fs", () => ({
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      readFileSync: mockFS.readFileSync,
      writeFileSync: mockFS.writeFileSync,
      unlinkSync: mockFS.unlink,
      rmdirSync: () => {}, // Mock directory removal as no-op
    }));

    // Mock session-db-io module to use our mock filesystem
    mockModule("./session-db-io", () => {
      return {
        readSessionDbFile: (options: any) => {
          try {
            const content = mockFS.readFileSync(options.dbPath || dbPath);
            const data = JSON.parse(content);
            return {
              sessions: data.sessions || [],
              baseDir: options.baseDir || "/test/base",
            };
          } catch (error) {
            // Return initial state if file doesn't exist
            return {
              sessions: [],
              baseDir: options.baseDir || "/test/base", 
            };
          }
        },
        writeSessionDbFile: (state: any, options: any) => {
          const filePath = options.dbPath || dbPath;
          mockFS.writeFileSync(filePath, JSON.stringify({
            sessions: state.sessions,
            baseDir: state.baseDir,
          }));
        },
      };
    });
  });

  it("should initialize with empty sessions", async () => {
    const adapter = new SessionAdapter(dbPath);
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should add and retrieve a session", async () => {
    const adapter = new SessionAdapter(dbPath);
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
    
    expect(retrievedSession !== null).toBe(true);
    expect(retrievedSession?.session).toBe("test-session");
    expect(retrievedSession?.taskId).toBe("#123");
  });

  it("should retrieve a session by task ID", async () => {
    const adapter = new SessionAdapter(dbPath);
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
    
    expect(retrievedSession !== null).toBe(true);
    expect(retrievedSession?.session).toBe("test-session");
  });

  it("should update a session", async () => {
    const adapter = new SessionAdapter(dbPath);
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
    const adapter = new SessionAdapter(dbPath);
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
    const adapter = new SessionAdapter(dbPath);
    const result = await adapter.deleteSession("non-existent");
    
    expect(result).toBe(false);
  });

  it("should get repository path for a session", async () => {
    const adapter = new SessionAdapter(dbPath);
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
    const adapter = new SessionAdapter(dbPath);
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
    
    expect(workdir !== null).toBe(true);
    expect(workdir).toContain("test-repo/sessions/test-session");
  });
}); 
