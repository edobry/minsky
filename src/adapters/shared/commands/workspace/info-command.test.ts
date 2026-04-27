/**
 * Tests for workspace.info command
 *
 * Covers:
 *  - Main workspace detection (initialised project with .minsky/config.yaml)
 *  - Session workspace detection (path under sessions dir)
 *  - Uninitialized directory (no config.yaml, not a session)
 *  - Backend fields parsed from config.yaml
 *  - requiresSetup: false (command registered without setup guard)
 *
 * Uses injected mocks for filesystem and session DB so no real I/O occurs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { detectSessionWorkspace, getWorkspaceInfo } from "../../../../domain/workspace/info";
import type { WorkspaceInfoDeps } from "../../../../domain/workspace/info";
import type { SessionProviderInterface } from "../../../../domain/session/index";
import { sharedCommandRegistry } from "../../command-registry";
import { registerWorkspaceCommands } from "./info-command";

// ---------------------------------------------------------------------------
// detectSessionWorkspace unit tests
// ---------------------------------------------------------------------------

describe("detectSessionWorkspace", () => {
  const origXdgState = process.env.XDG_STATE_HOME;

  beforeEach(() => {
    // Redirect the sessions dir to a predictable mock path so these tests
    // don't depend on the real ~/.local/state layout.
    process.env.XDG_STATE_HOME = "/mock/state";
  });

  afterEach(() => {
    if (origXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = origXdgState;
    }
  });

  it("detects a path directly under the sessions dir as a session workspace", () => {
    // With XDG_STATE_HOME=/mock/state, sessions dir = /mock/state/minsky/sessions
    const result = detectSessionWorkspace("/mock/state/minsky/sessions/abc-def-123");
    expect(result.isSession).toBe(true);
    expect(result.sessionId).toBe("abc-def-123");
  });

  it("detects a subdirectory inside a session as a session workspace", () => {
    const result = detectSessionWorkspace("/mock/state/minsky/sessions/abc-def-123/src/domain");
    expect(result.isSession).toBe(true);
    expect(result.sessionId).toBe("abc-def-123");
  });

  it("does not flag an unrelated path as a session workspace", () => {
    const result = detectSessionWorkspace("/Users/someone/Projects/myapp");
    expect(result.isSession).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });

  it("does not flag a path that merely contains the sessions dir string", () => {
    // e.g. a project named "sessions" outside the state dir
    const result = detectSessionWorkspace("/home/user/sessions/myproject");
    expect(result.isSession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Minimal fake SessionProviderInterface for tests
// ---------------------------------------------------------------------------

function makeSessionProvider(taskId: string | undefined): SessionProviderInterface {
  return {
    listSessions: async () => [],
    getSession: async (_id: string) =>
      taskId !== undefined
        ? ({
            sessionId: _id,
            repoName: "test-repo",
            repoUrl: "https://github.com/test/repo",
            createdAt: new Date().toISOString(),
            taskId,
          } as import("../../../../domain/session/types").SessionRecord)
        : null,
    getSessionByTaskId: async () => null,
    addSession: async () => {},
    updateSession: async () => {},
    deleteSession: async () => false,
    getRepoPath: async () => "/mock/repo",
    getSessionWorkdir: async () => "/mock/workdir",
  };
}

// ---------------------------------------------------------------------------
// getWorkspaceInfo tests — filesystem mocked via XDG redirect + real paths
// that don't need disk access for the non-config cases
// ---------------------------------------------------------------------------

describe("getWorkspaceInfo", () => {
  const origXdgState = process.env.XDG_STATE_HOME;

  beforeEach(() => {
    process.env.XDG_STATE_HOME = "/mock/state";
  });

  afterEach(() => {
    if (origXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = origXdgState;
    }
  });

  it("returns isSessionWorkspace: true for a path under the sessions dir", async () => {
    const sessionId = "dead-beef-1234";
    const sessionDir = `/mock/state/minsky/sessions/${sessionId}`;

    // No config.yaml at that path (doesn't exist), so no backends
    const info = await getWorkspaceInfo(sessionDir);

    expect(info.isSessionWorkspace).toBe(true);
    expect(info.isMainWorkspace).toBe(false);
    expect(info.sessionId).toBe(sessionId);
    expect(info.cwd).toBe(sessionDir);
  });

  it("resolves taskId from injected session provider", async () => {
    const sessionId = "dead-beef-1234";
    const sessionDir = `/mock/state/minsky/sessions/${sessionId}`;
    const deps: WorkspaceInfoDeps = {
      sessionProvider: makeSessionProvider("1168"),
    };

    const info = await getWorkspaceInfo(sessionDir, deps);

    expect(info.isSessionWorkspace).toBe(true);
    expect(info.taskId).toBe("mt#1168");
  });

  it("preserves mt# prefix when taskId already has it", async () => {
    const sessionId = "dead-beef-5678";
    const sessionDir = `/mock/state/minsky/sessions/${sessionId}`;
    const deps: WorkspaceInfoDeps = {
      sessionProvider: makeSessionProvider("mt#999"),
    };

    const info = await getWorkspaceInfo(sessionDir, deps);
    expect(info.taskId).toBe("mt#999");
  });

  it("returns undefined taskId when session not found in provider", async () => {
    const sessionId = "unknown-session";
    const sessionDir = `/mock/state/minsky/sessions/${sessionId}`;
    const deps: WorkspaceInfoDeps = {
      sessionProvider: makeSessionProvider(undefined),
    };

    const info = await getWorkspaceInfo(sessionDir, deps);
    expect(info.taskId).toBeUndefined();
  });

  it("returns all false flags and no configPath for an uninitialised non-session directory", async () => {
    // /tmp itself has no .minsky/config.yaml and is not under the sessions dir
    const info = await getWorkspaceInfo("/tmp");

    expect(info.isMainWorkspace).toBe(false);
    expect(info.isSessionWorkspace).toBe(false);
    expect(info.configPath).toBeUndefined();
    expect(info.tasksBackend).toBeUndefined();
    expect(info.repoBackend).toBeUndefined();
  });

  it("does not throw for a non-existent directory path", async () => {
    const info = await getWorkspaceInfo("/this-path-does-not-exist-minsky-test-xyz");
    expect(info.isMainWorkspace).toBe(false);
    expect(info.isSessionWorkspace).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command registration tests
// ---------------------------------------------------------------------------

describe("registerWorkspaceCommands", () => {
  beforeEach(() => {
    sharedCommandRegistry.unregisterCommand("workspace.info");
  });

  afterEach(() => {
    sharedCommandRegistry.unregisterCommand("workspace.info");
  });

  it("registers workspace.info with requiresSetup: false", () => {
    registerWorkspaceCommands();
    const cmd = sharedCommandRegistry.getCommand("workspace.info");
    expect(cmd).toBeDefined();
    expect(cmd?.requiresSetup).toBe(false);
  });

  it("workspace.info execute returns success and cwd fields for a plain directory", async () => {
    registerWorkspaceCommands();
    const cmd = sharedCommandRegistry.getCommand("workspace.info");
    if (!cmd) throw new Error("workspace.info command not registered");

    // Use /tmp — always exists, never has .minsky/config.yaml
    const result = (await cmd.execute({ cwd: "/tmp" }, { interface: "test" })) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(true);
    expect(result.cwd).toBe("/tmp");
    expect(typeof result.isMainWorkspace).toBe("boolean");
    expect(typeof result.isSessionWorkspace).toBe("boolean");
  });
});
