import { describe, it, expect, beforeEach } from "bun:test";
// Use mock.module() to mock filesystem operations
// import { promises as fs } from "fs";
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
  return { workdir: _workdir, stashed: true } as any;
};
const popStashMock = async (_workdir: string) => {
  popCount++;
  return { workdir: _workdir, stashed: false } as any;
};

import { createMarkdownTaskBackend } from "./markdownTaskBackend";

const sessionRoot = "/Users/edobry/.local/state/minsky/sessions/task-md#423";

describe("MarkdownTaskBackend - createTask auto-commit", () => {
  const testWorkspace = join(sessionRoot, "tmp", "md-backend-commit-test");
  const tasksDir = join(testWorkspace, "process");
  const tasksFile = join(tasksDir, "tasks.md");

  beforeEach(async () => {
    execCount = 0;
    stashCount = 0;
    popCount = 0;
    hasUncommitted = true;

    await fs.mkdir(tasksDir, { recursive: true });
    // Minimal tasks.md to start
    await fs.writeFile(tasksFile, "# Tasks\n", "utf-8");
  });

  it("commits and pushes after creating a task from object (title/description)", async () => {
    const backend: any = createMarkdownTaskBackend({
      workspacePath: testWorkspace,
      gitService: {
        execInRepository: async (wd: string, _cmd: string) => execInRepositoryMock(),
        hasUncommittedChanges: async (wd: string) => hasUncommittedChangesMock(),
        stashChanges: async (wd: string) => stashChangesMock(wd),
        popStash: async (wd: string) => popStashMock(wd),
      },
    } as any);

    const title = "Auto-commit test task";
    const description = "Ensure commit and push occur after creation";

    const task = await (backend as any).createTask({ title, description });

    expect(task).toBeDefined();
    // Stash and restore should both have occurred
    expect(stashCount).toBeGreaterThanOrEqual(1);
    expect(popCount).toBeGreaterThanOrEqual(1);
    // execInRepository should be called for add/commit/push at least 3 times
    expect(execCount).toBeGreaterThanOrEqual(3);
  });

  it("does not commit when there are no changes to commit", async () => {
    hasUncommitted = false;

    const backend: any = createMarkdownTaskBackend({
      workspacePath: testWorkspace,
      gitService: {
        execInRepository: async (wd: string, _cmd: string) => execInRepositoryMock(),
        hasUncommittedChanges: async (wd: string) => hasUncommittedChangesMock(),
        stashChanges: async (wd: string) => stashChangesMock(wd),
        popStash: async (wd: string) => popStashMock(wd),
      },
    } as any);

    const title = "No-change commit suppression";
    const description = "No git commit should occur";

    execCount = 0;
    await (backend as any).createTask({ title, description });

    // No commit path implies at most staging attempts; allow <=1 exec (defensive), but ensure not >=3
    expect(execCount).toBeLessThan(3);
  });
});
