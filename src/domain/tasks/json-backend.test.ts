import { describe, test, expect, beforeEach } from "bun:test";
import { createWorkspaceResolvingJsonBackend } from "./json-backend";
import { join } from "path";
import { createMockFs } from "../interfaces/mock-fs";

describe("Enhanced JSON Backend", () => {
  // Static mock paths to prevent environment dependencies
  const mockTestDir = "/mock/tmp/json-backend-test";
  let mockFs: ReturnType<typeof createMockFs>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFs({}, new Set([mockTestDir]));
  });

  test("should create backend with explicit workspace path", async () => {
    const backend = createWorkspaceResolvingJsonBackend(
      {
        name: "json-file",
        workspacePath: mockTestDir,
        dbFilePath: join(mockTestDir, "custom-tasks.json"),
      },
      mockFs
    );

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

    // Fix: Use createTaskFromTitleAndSpec instead of createTask with object
    const createdTask = await backend.createTaskFromTitleAndSpec(
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
    const backend = createWorkspaceResolvingJsonBackend(
      {
        name: "json-file",
        workspacePath: mockTestDir,
        dbFilePath: join(mockTestDir, "workspace-tasks.json"),
      },
      mockFs
    );

    // Test that the backend properly handles workspace paths
    const tasks = await backend.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });
});
