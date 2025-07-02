const TEST_VALUE = 123;

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
        readSessionDbFile: (options: unknown) => {
          try {
            const content = mockFS.readFileSync(options.dbPath || dbPath);
            const data = JSON.parse(content);
            return {
              sessions: data.sessions || [],
              baseDir: options.baseDir || "/test/base",
            };
          } catch {
            // Return initial state if file doesn't exist
            return {
              sessions: [],
              baseDir: options.baseDir || "/test/base",
            };
          }
        },
        writeSessionDbFile: (state: unknown, options: unknown = {}) => {
          const filePath = options.dbPath || dbPath;
          mockFS.writeFileSync(
            filePath,
            JSON.stringify({
              sessions: state.sessions,
              baseDir: state.baseDir,
            })
          );
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
      taskId: "#TEST_VALUE",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const retrievedSession = await adapter.getSession("test-session");

    expect(retrievedSession !== null).toBe(true);
    expect(retrievedSession?._session).toBe("test-session");
    expect(retrievedSession?.taskId).toBe("#TEST_VALUE");
  });

  it("should retrieve a session by task ID", async () => {
    const adapter = new SessionAdapter(dbPath);
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#TEST_VALUE",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const retrievedSession = await adapter.getSessionByTaskId("TEST_VALUE");

    expect(retrievedSession !== null).toBe(true);
    expect(retrievedSession?._session).toBe("test-session");
  });

  it("should update a session", async () => {
    const adapter = new SessionAdapter(dbPath);
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#TEST_VALUE",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    await adapter.updateSession("test-session", { _branch: "updated-branch" });

    const retrievedSession = await adapter.getSession("test-session");
    expect(retrievedSession?._branch).toBe("updated-branch");
  });

  it("should delete a session", async () => {
    const adapter = new SessionAdapter(dbPath);
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#TEST_VALUE",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const _result = await adapter.deleteSession("test-session");

    expect(_result).toBe(true);
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should return false when deleting a non-existent session", async () => {
    const adapter = new SessionAdapter(dbPath);
    const _result = await adapter.deleteSession("non-existent");

    expect(_result).toBe(false);
  });

  it("should get repository path for a session", async () => {
    const adapter = new SessionAdapter(dbPath);
    const testSession = {
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "test-url",
      createdAt: new Date().toISOString(),
      taskId: "#TEST_VALUE",
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
      taskId: "#TEST_VALUE",
      branch: "test-branch",
    };

    await adapter.addSession(testSession);
    const workdir = await adapter.getSessionWorkdir("test-session");

    expect(workdir !== null).toBe(true);
    expect(_workdir).toContain("test-repo/sessions/test-session");
  });
});
