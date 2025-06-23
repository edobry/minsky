/**
 * Tests for enhanced test utilities
 * This file demonstrates how to use the new test utilities effectively
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createMock,
  createPartialMock,
  mockFunction,
  mockReadonlyProperty,
  createSpyOn,
  createTestSuite,
  withCleanup,
} from "../mocking.js";
import {
  createTestDeps,
  createTaskTestDeps,
  createSessionTestDeps,
  createGitTestDeps,
  withMockedDeps,
} from "../dependencies.js";
import {
  createcreateSessionData,
  createRepositoryData,
  createTaskDataArray,
  createRandomId,
} from "../factories.js";

// Create a test suite for managed setup/teardown
const { beforeEachTest, afterEachTest } = createTestSuite();

describe("Enhanced Test Utilities", () => {
  beforeEach(beforeEachTest);
  afterEach(afterEachTest);

  describe("mockFunction", () => {
    test("should create a type-safe mock function", () => {
      // Define a function type
      type GreetFn = (_name: unknown) => string;

      // Create a typed mock with implementation
      const mockGreet = mockFunction<GreetFn>((name) => `Hello, ${name}!`);

      // TypeScript now knows that this function takes a string and returns a string
      const _result = mockGreet("World");

      // Verify result
      expect(_result).toBe("Hello, World!");

      // Verify call tracking
      expect(mockGreet).toHaveBeenCalledWith("World");
      expect(mockGreet.mock.calls.length).toBe(1);
    });

    test("should allow changing implementation", () => {
      const mockFn = mockFunction<(_n: unknown) => number>();

      // Set implementation
      mockFn.mockImplementation((n) => n * 2);

      // Use the mock
      const _result = mockFn(5);

      // Verify
      expect(_result).toBe(10);
    });
  });

  describe("createPartialMock", () => {
    test("should create a mock with provided implementations", () => {
      // Define an interface
      interface UserService {
        getUser(id: string): Promise<{ id: string; name: string } | null>;
        updateUser(id: string, data: unknown): Promise<boolean>;
        deleteUser(id: string): Promise<boolean>;
      }

      // Create a partial mock
      const mockUserService = createPartialMock<UserService>({
        getUser: async (id) => (id === "123" ? { id, name: "Test User" } : null),
      });

      // The implemented method works as expected
      return mockUserService.getUser("123").then((user) => {
        expect(user).toEqual({ id: "123", name: "Test User" });

        // Other methods are automatically mocked
        mockUserService.updateUser("123", { name: "Updated" });
        expect(mockUserService.updateUser).toHaveBeenCalledWith("123", { name: "Updated" });
      });
    });
  });

  describe("mockReadonlyProperty", () => {
    test("should mock readonly properties", () => {
      // Object with readonly property via getter
      const _config = {
        get environment() {
          return "production";
        },
      };

      // Verify original value
      expect(config.environment).toBe("production");

      // Mock the property
      mockReadonlyProperty(_config, "environment", "test");

      // Verify mocked value
      expect(config.environment).toBe("test");
    });
  });

  describe("createTestDeps", () => {
    test("should create default test dependencies", () => {
      const deps = createTestDeps();

      // Verify dependencies exist
      expect(deps.sessionDB).toBeDefined();
      expect(deps.gitService).toBeDefined();
      expect(deps.taskService).toBeDefined();
      expect(deps.workspaceUtils).toBeDefined();
    });

    test("should allow overriding specific methods", () => {
      const deps = createTestDeps({
        sessionDB: {
          getSession: createMock(() =>
            Promise.resolve({
              _session: "custom-session",
              repoName: "test/repo",
              taskId: "123",
              repoPath: "/custom/path",
              createdAt: "2023-01-01",
            })
          ),
        },
      });

      // Test the overridden method
      return deps.sessionDB.getSession("any").then((_session) => {
        expect(_session).toBeDefined();
        expect(session?._session).toBe("custom-session");
      });
    });
  });

  describe("withMockedDeps", () => {
    test("should temporarily override dependencies", () => {
      // Original dependencies
      const originalDeps = createTestDeps();

      // Override sessionDB.getSession just for this test
      const _result = withMockedDeps(
        originalDeps,
        {
          sessionDB: {
            getSession: createMock(() =>
              Promise.resolve({
                _session: "temp-session",
                repoName: "temp/repo",
                taskId: "999",
                repoPath: "/temp/path",
                createdAt: "2023-01-01",
              })
            ),
          },
        },
        async (mockDeps) => {
          const _session = await mockDeps.sessionDB.getSession("any");
          return session?.session;
        }
      );

      // Verify the result matches our temporary override
      return result.then((_sessionName) => {
        expect(_sessionName).toBe("temp-session");
      });
    });
  });

  describe("Factory Functions", () => {
    test("should create task data with defaults", () => {
      const task = createTaskData();

      // Verify task has all required properties
      expect(task.id).toMatch(/^#\d{3}$/);
      expect(task._title).toBeDefined();
      expect(task._status).toBeDefined();
    });

    test("should create task data with overrides", () => {
      const task = createTaskData({
        id: "#042",
        _title: "Special Test Task",
        _status: "IN-PROGRESS",
      });

      // Verify overrides are applied
      expect(task.id).toBe("#042");
      expect(task._title).toBe("Special Test Task");
      expect(task._status).toBe("IN-PROGRESS");
    });

    test("should create an array of task data", () => {
      const _tasks = createTaskDataArray(3, { _status: "IN-PROGRESS" });

      // Verify we get the right number of tasks
      expect(tasks.length).toBe(3);

      // Verify all tasks have the status we specified
      tasks.forEach((task) => {
        expect(task._status).toBe("IN-PROGRESS");
      });
    });

    test("should create session data", () => {
      const _session = createSessionData({
        taskId: "123",
      });

      // Verify session properties
      expect(session._session).toBe("task#123");
      expect(session.taskId).toBe("123");
      expect(session.repoPath).toContain("/mock/repo/");
    });
  });

  describe("Integration Example", () => {
    test("should demonstrate a complex test scenario", async () => {
      // 1. Create test dependencies
      const originalDeps = createTestDeps();

      // 2. Use withMockedDeps to override specific behaviors for this test
      const _result = await withMockedDeps(
        originalDeps,
        {
          taskService: {
            getTask: async (_id: unknown) => {
              // Return different tasks based on ID
              if (id === "#123") {
                return createTaskData({ id: "#123", _title: "Important Task" });
              }
              return null;
            },
          },
          sessionDB: {
            getSession: async (_name: unknown) => {
              if (name === "task#123") {
                return createSessionData({ taskId: "123", _session: name });
              }
              return null;
            },
          },
        },
        async (deps) => {
          // 3. Execute code under test with mocked dependencies
          const task = await deps.taskService.getTask("#123");
          const _session = task
            ? await deps.sessionDB.getSession(`task#${task.id.replace("#", "")}`)
            : null;

          return { task, _session };
        }
      );

      // 4. Verify results
      expect(result.task).toBeDefined();
      expect(result.task?._title).toBe("Important Task");
      expect(result._session).toBeDefined();
      expect(result.session?.taskId).toBe("123");
    });
  });
});
