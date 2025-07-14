import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync, mkdirSync, readFileSync } from "fs";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import { TaskService } from "../taskService";
import type { TaskData } from "../../../types/tasks/taskData";

describe("Real-World Workflow Testing", () => {
  const testBaseDir = join(tmpdir(), "minsky-test", `real-world-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  const testProcessDir = join(testBaseDir, "process");
  const testJsonPath = join(testProcessDir, "tasks.json");
  
  beforeEach(async () => {
    // Clean up and create test directory structure
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
    mkdirSync(testProcessDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe("JSON Backend Real Storage", () => {
    it("should actually create and store data in the correct location", async () => {
      // 1. Create JSON backend with special workspace path
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: testJsonPath // Explicit special workspace location
      });

      // 2. Verify the backend knows its storage location
      expect((jsonBackend as any).getStorageLocation()).toBe(testJsonPath);

      // 3. Create some test task data
      const testTasks: TaskData[] = [
        {
          id: "#001",
          title: "Test Task 1",
          status: "TODO",
          specPath: "process/tasks/001-test-task-1.md"
        },
        {
          id: "#002", 
          title: "Test Task 2",
          status: "IN-PROGRESS",
          specPath: "process/tasks/002-test-task-2.md"
        }
      ];

      // 4. Format and save the data
      const content = jsonBackend.formatTasks(testTasks);
      const saveResult = await jsonBackend.saveTasksData(content);

      // 5. Verify save was successful
      expect(saveResult.success).toBe(true);
      expect(saveResult.filePath).toBe(testJsonPath);

      // 6. Verify the file actually exists at the expected location
      expect(existsSync(testJsonPath)).toBe(true);

      // 7. Verify the file content is correct
      const fileContent = readFileSync(testJsonPath, "utf8");
      const parsedData = JSON.parse(fileContent);
      
      expect(parsedData.tasks).toHaveLength(2);
      expect(parsedData.tasks[0].id).toBe("#001");
      expect(parsedData.tasks[1].id).toBe("#002");
      expect(parsedData.metadata.storageLocation).toBe(testJsonPath);
      expect(parsedData.metadata.backendType).toBe("json-file");

      // 8. Test reading the data back
      const readResult = await jsonBackend.getTasksData();
      expect(readResult.success).toBe(true);
      
      const parsedTasks = jsonBackend.parseTasks(readResult.content!);
      expect(parsedTasks).toHaveLength(2);
      expect(parsedTasks[0].id).toBe("#001");
      expect(parsedTasks[1].id).toBe("#002");
    });

    it("should default to process/tasks.json when no explicit path provided", async () => {
      // Create backend without explicit dbFilePath
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir
      });

      // Should default to team-shareable location
      const expectedPath = join(testBaseDir, "process", "tasks.json");
      expect((jsonBackend as any).getStorageLocation()).toBe(expectedPath);
    });
  });

  describe("TaskService Integration", () => {
    it("should work with JSON backend for complete task operations", async () => {
      // 1. Create TaskService with JSON backend in special workspace location
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: testJsonPath
      });

      const taskService = new TaskService({
        workspacePath: testBaseDir,
        backend: "json-file",
        customBackends: [jsonBackend]
      });

      // 2. Verify TaskService is using the correct workspace
      expect(taskService.getWorkspacePath()).toBe(testBaseDir);

      // 3. Start with empty task list
      const initialTasks = await taskService.listTasks();
      expect(initialTasks).toHaveLength(0);

      // 4. Create some test data directly via backend to simulate existing tasks
      const testTasks: TaskData[] = [
        {
          id: "#100",
          title: "Test Task via Service",
          status: "TODO",
          specPath: "process/tasks/100-test-task-via-service.md"
        }
      ];

      const content = jsonBackend.formatTasks(testTasks);
      await jsonBackend.saveTasksData(content);

      // 5. Verify TaskService can read the tasks
      const tasks = await taskService.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("#100");
      expect(tasks[0].title).toBe("Test Task via Service");

      // 6. Test getting specific task
      const task = await taskService.getTask("#100");
      expect(task).not.toBeNull();
      expect(task!.id).toBe("#100");
      expect(task!.status).toBe("TODO");

      // 7. Test updating task status
      await taskService.setTaskStatus("#100", "IN-PROGRESS");

      // 8. Verify status was updated
      const updatedTask = await taskService.getTask("#100");
      expect(updatedTask!.status).toBe("IN-PROGRESS");

      // 9. Verify the file was actually updated
      expect(existsSync(testJsonPath)).toBe(true);
      const fileContent = readFileSync(testJsonPath, "utf8");
      const parsedData = JSON.parse(fileContent);
      expect(parsedData.tasks[0].status).toBe("IN-PROGRESS");
    });
  });

  describe("Error Handling", () => {
    it("should handle missing process directory gracefully", async () => {
      // Create backend pointing to non-existent directory
      const nonExistentPath = join(testBaseDir, "missing", "tasks.json");
      
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: nonExistentPath
      });

      // Should still work - the storage layer should create directories
      const testTasks: TaskData[] = [
        { id: "#001", title: "Test", status: "TODO", specPath: "test.md" }
      ];

      const content = jsonBackend.formatTasks(testTasks);
      const result = await jsonBackend.saveTasksData(content);

      // Should succeed by creating the directory structure
      expect(result.success).toBe(true);
      expect(existsSync(nonExistentPath)).toBe(true);
    });
  });
}); 
