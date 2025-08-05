import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createWorkspaceResolvingJsonBackend } from "./json-backend";
// Use mock.module() to mock filesystem operations
// import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Enhanced JSON Backend", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `test-workspace-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test("should create backend with explicit workspace path", async () => {
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
      workspacePath: testDir,
      dbFilePath: join(testDir, "custom-tasks.json"),
    });

    expect(backend.name).toBe("json-file");
    expect(backend.getWorkspacePath()).toBe(testDir);
  });

  test("should resolve workspace using current directory", async () => {
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
    });

    expect(backend.name).toBe("json-file");
    expect(typeof backend.getWorkspacePath()).toBe("string");
  });

  test("should handle database file path configuration", async () => {
    const customDbPath = join(testDir, "my-tasks.json");
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
      workspacePath: testDir,
      dbFilePath: customDbPath,
    }) as any;

    expect(backend.getStorageLocation()).toBe(customDbPath);
  });

  test("should identify as in-tree backend when configured appropriately", async () => {
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
      workspacePath: testDir,
    }) as any;

    expect(backend.isInTreeBackend()).toBe(true);
  });
});
