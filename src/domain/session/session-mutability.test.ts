/**
 * Tests for the merged-PR-freeze invariant (mt#684).
 *
 * Verifies that assertSessionMutable throws when a session's PR has been
 * merged, and that every write-path session operation calls it.
 */

import { describe, expect, test } from "bun:test";
import { assertSessionMutable } from "./session-mutability";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "684",
    backendType: "github",
    ...overrides,
  };
}

function mergedRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeRecord({
    prState: {
      branchName: "pr/test-session",
      lastChecked: new Date().toISOString(),
      mergedAt: "2026-04-07T00:00:00.000Z",
    },
    ...overrides,
  });
}

describe("assertSessionMutable", () => {
  test("throws when prState.mergedAt is set", () => {
    expect(() => assertSessionMutable(mergedRecord(), "do a thing")).toThrow(
      /merged sessions are frozen/
    );
  });

  test("includes the operation verb in the error message", () => {
    expect(() => assertSessionMutable(mergedRecord(), "create a pull request")).toThrow(
      /Cannot create a pull request/
    );
  });

  test("includes subtask guidance in the error message", () => {
    expect(() => assertSessionMutable(mergedRecord(), "do a thing")).toThrow(
      /create a subtask for the next phase/
    );
  });

  test("does NOT throw when prState.mergedAt is undefined", () => {
    const record = makeRecord({
      prState: {
        branchName: "pr/test-session",
        lastChecked: new Date().toISOString(),
      },
    });
    expect(() => assertSessionMutable(record, "do a thing")).not.toThrow();
  });

  test("does NOT throw when prState is undefined entirely", () => {
    expect(() => assertSessionMutable(makeRecord(), "do a thing")).not.toThrow();
  });
});

describe("sessionPrEdit refuses on merged session", () => {
  test("throws merged-frozen error", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [mergedRecord({ prBranch: "pr/test-session" })],
    });
    const { sessionPrEdit } = await import("./commands/pr-edit-subcommand");
    await expect(
      sessionPrEdit(
        { sessionId: "test-session", title: "new title" },
        { sessionDB },
        { interface: "mcp" }
      )
    ).rejects.toThrow(/merged sessions are frozen/);
  });
});

describe("approveSessionPr refuses on merged session", () => {
  test("throws merged-frozen error", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [mergedRecord({ prBranch: "pr/test-session" })],
    });
    const { approveSessionPr } = await import("./session-approval-operations");
    await expect(approveSessionPr({ session: "test-session" }, { sessionDB })).rejects.toThrow(
      /merged sessions are frozen/
    );
  });
});

describe("session_start refusal differentiates merged vs active", () => {
  test("merged existing session: error mentions merged + delete-first", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [mergedRecord({ session: "task-md#684", taskId: "md#684" })],
    });
    const { startSessionImpl } = await import("./start-session-operations");
    await expect(
      startSessionImpl(
        { task: "md#684", quiet: true } as any,
        {
          sessionDB,
          gitService: {} as any,
          taskService: {
            getTask: async () => ({ id: "md#684", title: "test", status: "READY" }) as any,
            getTaskStatus: async () => "READY",
          } as any,
          workspaceUtils: { isSessionWorkspace: async () => false } as any,
          getRepositoryBackend: async () => ({ repoUrl: "/tmp/repo", backendType: "github" }),
        } as any
      )
    ).rejects.toThrow(/merged at/);
  });

  test("active existing session: error mentions 'actively in use'", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [makeRecord({ session: "task-md#684", taskId: "md#684" })],
    });
    const { startSessionImpl } = await import("./start-session-operations");
    await expect(
      startSessionImpl(
        { task: "md#684", quiet: true } as any,
        {
          sessionDB,
          gitService: {} as any,
          taskService: {
            getTask: async () => ({ id: "md#684", title: "test", status: "READY" }) as any,
            getTaskStatus: async () => "READY",
          } as any,
          workspaceUtils: { isSessionWorkspace: async () => false } as any,
          getRepositoryBackend: async () => ({ repoUrl: "/tmp/repo", backendType: "github" }),
        } as any
      )
    ).rejects.toThrow(/actively in use/);
  });
});
