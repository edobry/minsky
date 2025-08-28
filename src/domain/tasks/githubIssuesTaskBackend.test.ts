/**
 * Tests for GitHubIssuesTaskBackend
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { GitHubIssuesTaskBackend, createGitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";

// Mock implementations that we can control and verify
const mockCreateGitHubLabels = mock(() => Promise.resolve());

describe("GitHubIssuesTaskBackend", () => {
  // Mock Octokit to prevent real GitHub API calls
  mock.module("@octokit/rest", () => ({
    Octokit: mock(() => ({
      rest: {
        issues: {
          getLabel: mock(() => Promise.resolve()),
          createLabel: mock(() => Promise.resolve()),
          list: mock(() => Promise.resolve({ data: [] })),
          get: mock(() => Promise.resolve({ data: {} })),
          create: mock(() => Promise.resolve({ data: {} })),
          update: mock(() => Promise.resolve({ data: {} })),
        },
      },
    })),
  }));

  // Mock the GitHub backend config to prevent real API calls
  mock.module("./githubBackendConfig", () => ({
    createGitHubLabels: mockCreateGitHubLabels,
  }));
  let backend: GitHubIssuesTaskBackend;

  beforeEach(() => {
    // Reset mock state before each test
    mockCreateGitHubLabels.mockClear();

    // Create backend instance for testing pure functions (API calls are mocked)
    backend = createGitHubIssuesTaskBackend({
      name: "github",
      workspacePath: "/test/workspace",
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
    }) as GitHubIssuesTaskBackend;
  });

  describe("configuration", () => {
    test("should create instance with correct configuration", () => {
      expect(backend.name).toBe("github");
      expect(backend.getWorkspacePath()).toBe("/test/workspace");
    });

    test("should initialize with custom status labels", () => {
      const customBackend = createGitHubIssuesTaskBackend({
        name: "github",
        workspacePath: "/test/workspace",
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        statusLabels: {
          TODO: "custom:todo",
          "IN-PROGRESS": "custom:in-progress",
          "IN-REVIEW": "custom:in-review",
          DONE: "custom:done",
          BLOCKED: "custom:blocked",
          CLOSED: "custom:closed",
        },
      });

      expect(customBackend).toBeDefined();
    });

    test("should initialize with proper label creation behavior", async () => {
      // Give the async ensureLabelsExist call time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify that the mock was called (this confirms initialization triggers label creation)
      expect(mockCreateGitHubLabels).toHaveBeenCalledTimes(1);
      expect(mockCreateGitHubLabels).toHaveBeenCalledWith(
        expect.any(Object), // octokit instance
        "test-owner",
        "test-repo",
        expect.any(Object) // status labels
      );
    });
  });

  describe("parseTasks", () => {
    test("should parse GitHub issues into TaskData objects", () => {
      const issuesJson = JSON.stringify([
        {
          id: 1,
          number: 1,
          title: "Test Issue #001",
          body: "Test description",
          state: "open",
          labels: [{ name: "minsky:todo", color: "d73a4a" }],
          assignees: [],
          html_url: "https://github.com/test-owner/test-repo/issues/1",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);

      expect(tasks.length).toBe(1);
      expect(tasks[0]?.id).toBe("gh#001");
      expect(tasks[0]?.title).toBe("Test Issue #001");
      expect(tasks[0]?.description).toBe("Test description");
      expect(tasks[0]?.status).toBe("TODO");
    });

    test("should handle invalid JSON gracefully", () => {
      const tasks = backend.parseTasks("invalid json");
      expect(tasks).toEqual([]);
    });

    test("should handle empty GitHub response", () => {
      const tasks = backend.parseTasks("[]");
      expect(tasks).toEqual([]);
    });

    test("should map GitHub issue states correctly", () => {
      const issuesJson = JSON.stringify([
        {
          id: 1,
          number: 1,
          title: "Open Issue",
          body: "",
          state: "open",
          labels: [{ name: "minsky:todo", color: "d73a4a" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/1",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
        {
          id: 2,
          number: 2,
          title: "Closed Issue",
          body: "",
          state: "closed",
          labels: [{ name: "minsky:done", color: "28a745" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/2",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);

      expect(tasks).toHaveLength(2);
      expect(tasks[0]?.status).toBe("TODO");
      expect(tasks[1]?.status).toBe("DONE");
    });
  });

  describe("formatTasks", () => {
    test("should format TaskData objects for GitHub API", () => {
      const tasks = [
        {
          id: "#001",
          title: "Test Task",
          description: "Test description",
          status: "TODO" as const,
          specPath: "process/tasks/001-test-task.md",
        },
      ];

      const _result = backend.formatTasks(tasks);
      const formattedTasks = JSON.parse(_result);

      expect(formattedTasks.length).toBe(1);
      expect(formattedTasks[0]?.title).toBe("Test Task");
      expect(formattedTasks[0]?.body).toBe("Test description");
      expect(formattedTasks[0]?.state).toBe("open");
    });
  });

  describe("parseTaskSpec", () => {
    test("should parse task specification content", () => {
      const specContent = `# Task #001: Test Task

## Description
This is a test task description.

## Requirements
- Requirement 1
- Requirement 2
`;

      const spec = backend.parseTaskSpec(specContent);

      expect(spec.title).toBe("Test Task");
      expect(spec.description).toBe("This is a test task description.");
      expect(spec.metadata?.taskId).toBe("#001");
    });
  });

  describe("formatTaskSpec", () => {
    test("should format task specification data", () => {
      const spec = {
        title: "Test Task",
        description: "Test description",
        metadata: {
          taskId: "001",
          githubIssue: {
            number: 1,
            html_url: "https://github.com/test/repo/issues/1",
            state: "open",
          },
        },
      };

      const _result = backend.formatTaskSpec(spec);

      expect(_result).toContain("# Task 001: Test Task");
      expect(_result).toContain("## Description\nTest description");
      expect(_result).toContain("## GitHub Issue");
      expect(_result).toContain("- Issue: #1");
    });
  });

  describe("getTaskSpecPath", () => {
    test("should generate correct spec path", () => {
      const path = backend.getTaskSpecPath("#001", "Test Task");
      expect(path).toBe("process/tasks/001-test-task.md");
    });

    test("should handle task ID without # prefix", () => {
      const path = backend.getTaskSpecPath("001", "Test Task");
      expect(path).toBe("process/tasks/001-test-task.md");
    });

    test("should normalize title for filename", () => {
      const path = backend.getTaskSpecPath("#001", "Test Task With Special Characters!");
      expect(path).toBe("process/tasks/001-test-task-with-special-characters-.md");
    });
  });
});
