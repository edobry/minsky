import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createWorkspaceResolvingJsonBackend } from "./json-backend";
import { join } from "path";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

describe("Enhanced JSON Backend", () => {
  // Static mock paths to prevent environment dependencies
  const mockTestDir = "/mock/tmp/json-backend-test";
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
      rmSync: mockFs.rmSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      promises: {
        mkdir: mockFs.mkdir,
        writeFile: mockFs.writeFile,
        readFile: mockFs.readFile,
        readdir: mockFs.readdir,
        rm: mockFs.rm,
        access: mockFs.access,
        mkdtemp: () => Promise.resolve("/mock/tmp/test-12345"),
      },
    }));

    // Also mock fs/promises for JsonFileStorage
    mock.module("fs/promises", () => ({
      mkdir: mockFs.mkdir,
      writeFile: mockFs.writeFile,
      readFile: mockFs.readFile,
      readdir: mockFs.readdir,
      rm: mockFs.rm,
      access: mockFs.access,
      mkdtemp: () => Promise.resolve("/mock/tmp/test-12345"),
    }));

    // Ensure mock test directory exists
    mockFs.ensureDirectoryExists(mockTestDir);
  });

  afterEach(() => {
    try {
      // Clean up using mock filesystem
      mockFs.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test("should create backend with explicit workspace path", async () => {
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
      workspacePath: mockTestDir,
      dbFilePath: join(mockTestDir, "custom-tasks.json"),
    });

    expect(backend).toBeDefined();
    expect(backend.name).toBe("json-file");

    // Test basic functionality
    const testTask = {
      id: "test-task-1",
      title: "Test Task",
      description: "A test task",
      status: "TODO" as const,
      metadata: {
        created: new Date().toISOString(),
        workspace: mockTestDir,
      },
    };

    // Fix: Use createTaskFromTitleAndDescription instead of createTask with object
    const createdTask = await backend.createTaskFromTitleAndDescription(
      testTask.title,
      testTask.description,
      {
        id: testTask.id,
      }
    );

    // Use the actual ID that was created, not the one we passed
    const retrievedTask = await backend.getTask(createdTask.id);

    expect(retrievedTask).toBeDefined();
    expect(retrievedTask?.title).toBe("Test Task");
  });

  test("should handle workspace path resolution", async () => {
    const backend = createWorkspaceResolvingJsonBackend({
      name: "json-file",
      workspacePath: mockTestDir,
      dbFilePath: join(mockTestDir, "workspace-tasks.json"),
    });

    // Test that the backend properly handles workspace paths
    const tasks = await backend.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });
});
