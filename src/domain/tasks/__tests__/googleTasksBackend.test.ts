import { describe, it, expect } from "bun:test";
import {
  GoogleTasksBackend,
  createGoogleTasksBackend,
  type GoogleTasksBackendOptions,
} from "../googleTasksBackend";
import type { TaskData } from "../../../types/tasks/taskData";

describe("GoogleTasksBackend", () => {
  const mockConfig: GoogleTasksBackendOptions = {
    name: "google-tasks",
    workspacePath: "/tmp/test-workspace",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:3000/callback",
    tokenPath: "/tmp/test-tokens.json",
    scopes: ["https://www.googleapis.com/auth/tasks"],
  };

  describe("Factory function", () => {
    it("should create a GoogleTasksBackend instance", () => {
      const backend = createGoogleTasksBackend(mockConfig);
      expect(backend).toBeInstanceOf(GoogleTasksBackend);
      expect(backend.name).toBe("google-tasks");
    });
  });

  describe("TaskBackend interface", () => {
    it("should implement required methods", () => {
      const backend = new GoogleTasksBackend(mockConfig);

      expect(typeof backend.getTasksData).toBe("function");
      expect(typeof backend.getTaskSpecData).toBe("function");
      expect(typeof backend.parseTasks).toBe("function");
      expect(typeof backend.formatTasks).toBe("function");
      expect(typeof backend.parseTaskSpec).toBe("function");
      expect(typeof backend.formatTaskSpec).toBe("function");
      expect(typeof backend.saveTasksData).toBe("function");
      expect(typeof backend.saveTaskSpecData).toBe("function");
      expect(typeof backend.getWorkspacePath).toBe("function");
      expect(typeof backend.getTaskSpecPath).toBe("function");
      expect(typeof backend.fileExists).toBe("function");
    });

    it("should return correct workspace path", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      expect(backend.getWorkspacePath()).toBe(mockConfig.workspacePath);
    });

    it("should generate correct task spec path", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const specPath = backend.getTaskSpecPath("123", "Test Task");
      expect(specPath).toContain("process/tasks/123-test-task.md");
    });
  });

  describe("Task parsing and formatting", () => {
    it("should parse JSON task data correctly", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const jsonData = JSON.stringify([
        {
          id: "1",
          title: "Test Task",
          description: "Test Description",
          status: "TODO",
        },
      ]);

      const tasks = backend.parseTasks(jsonData);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("1");
      expect(tasks[0].title).toBe("Test Task");
      expect(tasks[0].status).toBe("TODO");
    });

    it("should format tasks to JSON correctly", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const tasks: TaskData[] = [
        {
          id: "1",
          title: "Test Task",
          description: "Test Description",
          status: "TODO",
          worklog: [],
        },
      ];

      const formattedData = backend.formatTasks(tasks);
      const parsed = JSON.parse(formattedData);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("1");
    });

    it("should parse task spec from JSON correctly", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const specData = JSON.stringify({
        title: "Test Spec",
        description: "Test Description",
        metadata: {
          requirements: ["Requirement 1"],
          acceptanceCriteria: ["Criteria 1"],
        },
      });

      const spec = backend.parseTaskSpec(specData);
      expect(spec.title).toBe("Test Spec");
      expect(spec.description).toBe("Test Description");
      expect(spec.metadata).toBeDefined();
      expect(spec.metadata!.requirements).toEqual(["Requirement 1"]);
      expect(spec.metadata!.acceptanceCriteria).toEqual(["Criteria 1"]);
    });

    it("should format task spec to JSON correctly", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const spec = {
        title: "Test Spec",
        description: "Test Description",
      };

      const formatted = backend.formatTaskSpec(spec);
      const parsed = JSON.parse(formatted);
      expect(parsed.title).toBe("Test Spec");
      expect(parsed.description).toBe("Test Description");
    });
  });

  describe("OAuth URL generation", () => {
    it("should generate authentication URL", () => {
      const backend = new GoogleTasksBackend(mockConfig);
      const authUrl = backend.generateAuthUrl();

      expect(authUrl).toContain("accounts.google.com");
      expect(authUrl).toContain("oauth2");
      expect(authUrl).toContain(mockConfig.clientId);
      expect(authUrl).toContain("tasks");
    });
  });
});
