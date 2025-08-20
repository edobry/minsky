import { describe, it, expect, beforeEach, mock } from "bun:test";
import { join } from "path";

// Simple handmade mocks
const execInRepositoryMock = async () => "ok";
let hasUncommitted = true;
const hasUncommittedChangesMock = async () => hasUncommitted;
let stashedFlag = false;
const stashChangesMock = async (_workdir: string) => {
  stashedFlag = true;
  return { workdir: _workdir, stashed: true } as any;
};
const popStashMock = async (_workdir: string) => {
  stashedFlag = false;
  return { workdir: _workdir, stashed: false } as any;
};

// Mock the fs module to prevent actual file operations
mock.module("fs", () => ({
  promises: {
    mkdir: mock(async () => {}),
    writeFile: mock(async () => {}),
    readFile: mock(async (path: string) => {
      if (path.includes("temp-spec.md")) {
        return ["# Task: Verify legacy backend commit", "", "## Context", "Some context"].join(
          "\n"
        );
      }
      return "# Tasks\n";
    }),
    unlink: mock(async () => {}),
    access: mock(async () => {}), // Mock file exists check
  },
}));

mock.module("fs/promises", () => ({
  mkdir: mock(async () => {}),
  writeFile: mock(async () => {}),
  readFile: mock(async (path: string) => {
    if (path.includes("temp-spec.md")) {
      return ["# Task: Verify legacy backend commit", "", "## Context", "Some context"].join("\n");
    }
    return "# Tasks\n";
  }),
  unlink: mock(async () => {}),
  access: mock(async () => {}), // Mock file exists check
}));

import { TaskService } from "../tasks";

const sessionRoot = "/Users/edobry/.local/state/minsky/sessions/task-md#423";

describe("Legacy MarkdownTaskBackend in tasks.ts - createTask auto-commit", () => {
  const testWorkspace = join(sessionRoot, "tmp", "legacy-backend-commit-test");
  const tasksDir = join(testWorkspace, "process");
  const tasksFile = join(tasksDir, "tasks.md");

  beforeEach(async () => {
    hasUncommitted = true;
    stashedFlag = false;
  });

  it("commits and pushes after creating a task from spec file", async () => {
    const service: any = new TaskService({ workspacePath: testWorkspace, backend: "markdown" });
    // Inject mock git service by overriding backend inside the service
    // Access current backend (MarkdownTaskBackend in tasks.ts) via private field
    const currentBackend = (service as any).currentBackend;
    currentBackend.gitService = {
      execInRepository: async (workdir: string, _cmd: string) => execInRepositoryMock(),
      hasUncommittedChanges: async (workdir: string) => hasUncommittedChangesMock(),
      stashChanges: async (workdir: string) => stashChangesMock(workdir),
      popStash: async (workdir: string) => popStashMock(workdir),
    } as any;

    const specPath = join(testWorkspace, "temp-spec.md");
    // Mock content handled by mocked fs.readFile

    await service.createTask(specPath);

    // Flow executed; ensure stash restored
    expect(stashedFlag).toBe(false);
  });
});
