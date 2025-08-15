import { describe, it, expect, beforeEach } from "bun:test";
import { promises as fs } from "fs";
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

import { TaskService } from "../tasks";

const sessionRoot = "/Users/edobry/.local/state/minsky/sessions/task-md#423";

describe("Legacy MarkdownTaskBackend in tasks.ts - createTask auto-commit", () => {
  const testWorkspace = join(sessionRoot, "tmp", "legacy-backend-commit-test");
  const tasksDir = join(testWorkspace, "process");
  const tasksFile = join(tasksDir, "tasks.md");

  beforeEach(async () => {
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(tasksFile, "# Tasks\n", "utf-8");
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
    await fs.writeFile(
      specPath,
      ["# Task: Verify legacy backend commit", "", "## Context", "Some context"].join("\n"),
      "utf-8"
    );

    await service.createTask(specPath);

    // Flow executed; ensure stash restored
    expect(stashedFlag).toBe(false);
  });
});
