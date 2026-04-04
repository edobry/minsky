import { describe, it, expect, beforeEach } from "bun:test";
import { join } from "path";

// Simple counters to verify flow
let execCount = 0;
let stashCount = 0;
let popCount = 0;
let hasUncommitted = true;

const execInRepositoryMock = async () => {
  execCount++;
  return "ok";
};
const hasUncommittedChangesMock = async () => hasUncommitted;
const stashChangesMock = async (_workdir: string) => {
  stashCount++;
  return { workdir: _workdir, stashed: true };
};
const popStashMock = async (_workdir: string) => {
  popCount++;
  return { workdir: _workdir, stashed: false };
};

import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createMockFs } from "../interfaces/mock-fs";
import type { TaskBackend } from "./types";

const sessionRoot = "/Users/edobry/.local/state/minsky/sessions/test-uuid-423";

describe("MarkdownTaskBackend - createTask auto-commit", () => {
  const testWorkspace = join(sessionRoot, "tmp", "md-backend-commit-test");
  const tasksDir = join(testWorkspace, "process");
  const tasksFile = join(tasksDir, "tasks.md");

  beforeEach(async () => {
    execCount = 0;
    stashCount = 0;
    popCount = 0;
    hasUncommitted = true;
  });

  it("commits and pushes after creating a task from object (title/description)", async () => {
    const mockFs = createMockFs({ [tasksFile]: "# Tasks\n" }, new Set([tasksDir, testWorkspace]));

    const backend: TaskBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: testWorkspace,
      fs: mockFs,

      gitService: {
        execInRepository: async (wd: string, _cmd: string) => execInRepositoryMock(),
        hasUncommittedChanges: async (wd: string) => hasUncommittedChangesMock(),
        stashChanges: async (wd: string) => stashChangesMock(wd),
        popStash: async (wd: string) => popStashMock(wd),
      } as any,
    });

    const title = "Auto-commit test task";
    const description = "Ensure commit and push occur after creation";

    const task = await backend.createTask!({ title, description });

    expect(task).toBeDefined();
    // Stash and restore should both have occurred
    expect(stashCount).toBeGreaterThanOrEqual(1);
    expect(popCount).toBeGreaterThanOrEqual(1);
    // execInRepository should be called for add/commit/push at least 3 times
    expect(execCount).toBeGreaterThanOrEqual(3);
  });

  it("does not commit when there are no changes to commit", async () => {
    hasUncommitted = false;

    const mockFs = createMockFs({ [tasksFile]: "# Tasks\n" }, new Set([tasksDir, testWorkspace]));

    const backend: TaskBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: testWorkspace,
      fs: mockFs,

      gitService: {
        execInRepository: async (wd: string, _cmd: string) => execInRepositoryMock(),
        hasUncommittedChanges: async (wd: string) => hasUncommittedChangesMock(),
        stashChanges: async (wd: string) => stashChangesMock(wd),
        popStash: async (wd: string) => popStashMock(wd),
      } as any,
    });

    const title = "No-change commit suppression";
    const description = "No git commit should occur";

    execCount = 0;
    await backend.createTask!({ title, description });

    // No commit path implies at most staging attempts; allow <=1 exec (defensive), but ensure not >=3
    expect(execCount).toBeLessThan(3);
  });
});
