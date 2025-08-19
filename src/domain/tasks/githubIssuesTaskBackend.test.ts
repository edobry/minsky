import { describe, test, expect, mock } from "bun:test";
import { GitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";
import type { GitHubTaskBackendConfig } from "./githubBackendFactory";

// Mock Octokit
const mockOctokit = {
  rest: {
    issues: {
      listForRepo: mock(),
      get: mock(),
      create: mock(),
      update: mock(),
    },
  },
};

// Mock the Octokit constructor
mockModule("@octokit/rest", () => ({
  Octokit: mock(),
}));

describe("GitHubIssuesTaskBackend", () => {
  let backend: GitHubIssuesTaskBackend;
  let config: GitHubTaskBackendConfig;

  beforeEach(() => {
    config = {
      name: "github-issues",
      workspacePath: "/test/workspace",
      token: "fake-token",
      owner: "test-owner",
      repo: "test-repo",
    };
    backend = new GitHubIssuesTaskBackend(config);

    // Reset mocks
    mockOctokit.rest.issues.listForRepo.mockReset();
    mockOctokit.rest.issues.get.mockReset();
    mockOctokit.rest.issues.create.mockReset();
    mockOctokit.rest.issues.update.mockReset();
  });

  describe("listTasks", () => {
    test("should list tasks from GitHub issues", async () => {
      const mockIssues = [
        {
          number: 1,
          title: "Test Issue 1",
          body: "Test body 1",
          state: "open",
          labels: [{ name: "TODO" }],
          html_url: "https://github.com/test-owner/test-repo/issues/1",
        },
        {
          number: 2,
          title: "Test Issue 2",
          body: "Test body 2",
          state: "closed",
          labels: [{ name: "DONE" }],
          html_url: "https://github.com/test-owner/test-repo/issues/2",
        },
      ];

      mockOctokit.rest.issues.listForRepo = mock(() => Promise.resolve({ data: mockIssues }));

      const tasks = await backend.listTasks();

      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("gh#1");
      expect(tasks[0].title).toBe("Test Issue 1");
      expect(tasks[0].status).toBe("TODO");
      expect(tasks[1].id).toBe("gh#2");
      expect(tasks[1].status).toBe("DONE");
    });

    test("should filter tasks by status", async () => {
      const mockIssues = [
        {
          number: 1,
          title: "Test Issue 1",
          body: "Test body 1",
          state: "open",
          labels: [{ name: "TODO" }],
          html_url: "https://github.com/test-owner/test-repo/issues/1",
        },
      ];

      mockOctokit.rest.issues.listForRepo = mock(() => Promise.resolve({ data: mockIssues }));

      const tasks = await backend.listTasks({ status: "TODO" });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("TODO");
    });
  });

  describe("getTask", () => {
    test("should get a specific task by ID", async () => {
      const mockIssue = {
        number: 1,
        title: "Test Issue",
        body: "Test body",
        state: "open",
        labels: [{ name: "TODO" }],
        html_url: "https://github.com/test-owner/test-repo/issues/1",
      };

      mockOctokit.rest.issues.get = mock(() => Promise.resolve({ data: mockIssue }));

      const task = await backend.getTask("gh#1");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("gh#1");
      expect(task?.title).toBe("Test Issue");
      expect(task?.status).toBe("TODO");
    });

    test("should return null for non-existent task", async () => {
      mockOctokit.rest.issues.get = mock(() => Promise.reject(new Error("Not found")));

      const task = await backend.getTask("gh#999");

      expect(task).toBeNull();
    });
  });

  describe("setTaskStatus", () => {
    test("should update task status via GitHub API", async () => {
      mockOctokit.rest.issues.update = mock(() => Promise.resolve({}));

      await backend.setTaskStatus("gh#1", "DONE");

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 1,
        state: "closed",
        labels: ["DONE"],
      });
    });
  });

  describe("createTaskFromTitleAndDescription", () => {
    test("should create a new GitHub issue", async () => {
      const mockIssue = {
        number: 1,
        title: "New Task",
        body: "New description",
        state: "open",
        labels: [{ name: "TODO" }],
        html_url: "https://github.com/test-owner/test-repo/issues/1",
      };

      mockOctokit.rest.issues.create = mock(() => Promise.resolve({ data: mockIssue }));

      const task = await backend.createTaskFromTitleAndDescription("New Task", "New description");

      expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        title: "New Task",
        body: "New description",
        labels: ["TODO"],
      });

      expect(task.id).toBe("gh#1");
      expect(task.title).toBe("New Task");
      expect(task.status).toBe("TODO");
    });
  });

  describe("deleteTask", () => {
    test("should close GitHub issue (delete not supported)", async () => {
      mockOctokit.rest.issues.update = mock(() => Promise.resolve({}));

      const result = await backend.deleteTask("gh#1");

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 1,
        state: "closed",
        labels: ["CLOSED"],
      });

      expect(result).toBe(true);
    });
  });

  describe("getCapabilities", () => {
    test("should return correct capabilities", () => {
      const capabilities = backend.getCapabilities();

      expect(capabilities.canCreate).toBe(true);
      expect(capabilities.canUpdate).toBe(true);
      expect(capabilities.canDelete).toBe(false); // GitHub doesn't support deleting issues
      expect(capabilities.canList).toBe(true);
      expect(capabilities.supportsMetadata).toBe(true);
      expect(capabilities.supportsSearch).toBe(true);
    });
  });

  describe("getTaskMetadata", () => {
    test("should get task metadata from GitHub issue", async () => {
      const mockIssue = {
        number: 1,
        title: "Test Issue",
        body: "Test body",
        state: "open",
        labels: [{ name: "TODO" }],
        created_at: "2023-01-01T00:00:00Z",
        updated_at: "2023-01-02T00:00:00Z",
        html_url: "https://github.com/test-owner/test-repo/issues/1",
      };

      mockOctokit.rest.issues.get = mock(() => Promise.resolve({ data: mockIssue }));

      const metadata = await backend.getTaskMetadata("gh#1");

      expect(metadata).not.toBeNull();
      expect(metadata?.id).toBe("gh#1");
      expect(metadata?.title).toBe("Test Issue");
      expect(metadata?.spec).toBe("Test body");
      expect(metadata?.status).toBe("TODO");
      expect(metadata?.backend).toBe("github-issues");
    });
  });

  describe("setTaskMetadata", () => {
    test("should update task metadata via GitHub API", async () => {
      mockOctokit.rest.issues.update = mock(() => Promise.resolve({}));

      const metadata = {
        id: "gh#1",
        title: "Updated Title",
        spec: "Updated body",
        status: "IN-PROGRESS",
        backend: "github-issues",
      };

      await backend.setTaskMetadata("gh#1", metadata);

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 1,
        title: "Updated Title",
        body: "Updated body",
        state: "open",
        labels: ["IN-PROGRESS"],
      });
    });
  });
});
