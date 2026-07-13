/**
 * Tests for GitHubIssuesTaskBackend
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { GitHubIssuesTaskBackend, createGitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";

import { TaskStatus } from "./taskConstants";

// Mock implementations that we can control and verify
const mockCreateGitHubLabels = mock(() => Promise.resolve());

// Mock Octokit instance — injected via options
const mockOctokit = {
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
};

describe("GitHubIssuesTaskBackend", () => {
  let backend: GitHubIssuesTaskBackend;

  beforeEach(() => {
    // Reset mock state before each test
    mockCreateGitHubLabels.mockClear();

    // Create backend instance with injected mocks — no module mocking needed
    backend = createGitHubIssuesTaskBackend({
      name: "github",
      workspacePath: "/test/workspace",
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      octokit: mockOctokit as any,
      createGitHubLabelsFn: mockCreateGitHubLabels,
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
        octokit: mockOctokit as any,
        createGitHubLabelsFn: mockCreateGitHubLabels,
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
    test("should parse GitHub issues into TaskData objects using issue.number as ID", () => {
      // REGRESSION TEST for mt#2572 Bug 1&2: task ID must be derived from issue.number,
      // NOT from the issue title.  The title "Test Issue #001" would previously cause
      // the task to be stored as gh#001 instead of gh#1, making it invisible by its
      // real number and causing wrong id→content mapping for other tasks.
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
      // ID must be gh#1 (from issue.number), NOT gh#001 (from title parsing)
      expect(tasks[0]?.id).toBe("gh#1");
      expect(tasks[0]?.title).toBe("Test Issue #001");
      expect(tasks[0]?.spec).toBe("Test description");
      expect(tasks[0]?.status).toBe(TaskStatus.TODO);
    });

    test("mt#2572 Bug 2: title containing another issue ref does not alias the task ID", () => {
      // If issue #1765 has title "Re-attempt task from gh#1762", the OLD code would
      // map it to gh#1762, making tasks_get gh#1765 return gh#1762's content and
      // making gh#1765 invisible.  The fix: always use issue.number.
      const issuesJson = JSON.stringify([
        {
          id: 1762,
          number: 1762,
          title: "Original task",
          body: "Original content",
          state: "open",
          labels: [{ name: "minsky:todo", color: "d73a4a" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/1762",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
        {
          id: 1765,
          number: 1765,
          title: "Re-attempt task from gh#1762",
          body: "New content for 1765",
          state: "open",
          labels: [{ name: "minsky:todo", color: "d73a4a" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/1765",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);
      const taskById = new Map(tasks.map((t) => [t.id, t]));

      // Both tasks must be independently addressable by their own issue number
      expect(taskById.get("gh#1762")?.title).toBe("Original task");
      expect(taskById.get("gh#1762")?.spec).toBe("Original content");
      expect(taskById.get("gh#1765")?.title).toBe("Re-attempt task from gh#1762");
      expect(taskById.get("gh#1765")?.spec).toBe("New content for 1765");
      // gh#1762 must NOT appear twice (no aliasing)
      expect(tasks.filter((t) => t.id === "gh#1762")).toHaveLength(1);
    });

    test("mt#2572 Bug 1 secondary: labels with color:null do not break validation", () => {
      // GitHub API labels can have color:null. The old strict schema required color:string,
      // so a single null-color label in ANY issue would throw and parseGitHubIssues
      // would catch + return [] — making ALL tasks invisible.
      const issuesJson = JSON.stringify([
        {
          id: 1,
          number: 1,
          title: "Task with null-color label",
          body: "Should still parse",
          state: "open",
          labels: [
            { name: "minsky:todo", color: null },
            { name: "some-tag", color: null },
          ],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/1",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe("gh#1");
    });

    test("mt#2572 Bug 1 secondary: string labels do not break validation", () => {
      // GitHub API can return labels as plain strings in some response shapes.
      const issuesJson = JSON.stringify([
        {
          id: 2,
          number: 2,
          title: "Task with string label",
          body: "Should parse",
          state: "open",
          labels: ["minsky:todo", "other-tag"],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/2",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe("gh#2");
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
      expect(tasks[0]?.status).toBe(TaskStatus.TODO);
      expect(tasks[1]?.status).toBe(TaskStatus.DONE);
    });
  });

  describe("formatTasks", () => {
    test("should format TaskData objects for GitHub API", () => {
      const tasks = [
        {
          id: "#001",
          title: "Test Task",
          spec: "Test description",
          status: TaskStatus.TODO,
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
      expect(spec.body).toBe("This is a test task description.");
      expect(spec.metadata?.taskId).toBe("#001");
    });
  });

  describe("formatTaskSpec", () => {
    test("should format task specification data", () => {
      const spec = {
        title: "Test Task",
        body: "Test description",
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

  describe("mt#2572 Bug 3: status write verification", () => {
    test("PLANNING status maps to minsky:planning label (not minsky:todo fallback)", () => {
      // REGRESSION: DEFAULT_STATUS_LABELS was missing PLANNING, READY, COMPLETED.
      // getLabelsForTaskStatus("PLANNING", statusLabels) returned ["minsky:todo"] (fallback).
      // This test verifies the label is correctly resolved.
      // Access internal statusLabels via backend capabilities — indirectly test via parseTasks
      const issuesJson = JSON.stringify([
        {
          id: 1,
          number: 1,
          title: "Task in planning",
          body: "",
          state: "open",
          labels: [{ name: "minsky:planning", color: "0075ca" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/1",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);
      // With PLANNING in DEFAULT_STATUS_LABELS, the issue is recognised as a Minsky task
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe(TaskStatus.PLANNING);
    });

    test("READY status maps to minsky:ready label", () => {
      const issuesJson = JSON.stringify([
        {
          id: 2,
          number: 2,
          title: "Task that is ready",
          body: "",
          state: "open",
          labels: [{ name: "minsky:ready", color: "0075ca" }],
          assignees: [],
          html_url: "https://github.com/test/repo/issues/2",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-01-01T00:00:00Z",
        },
      ]);

      const tasks = backend.parseTasks(issuesJson);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe(TaskStatus.READY);
    });

    test("setTaskStatus throws when GitHub does not reflect the expected label after write", async () => {
      // REGRESSION: updateIssueStatus had no read-back verification — it always returned
      // silently even if the label was not written (false-success in mt#2572 Bug 3).
      // Mock the GitHub update to return labels that do NOT include the expected label.
      const mockIssuesListFail = mock(() =>
        Promise.resolve([
          {
            id: 1,
            number: 1,
            title: "Task in todo",
            body: "",
            state: "open",
            labels: [{ name: "minsky:todo", color: "d73a4a" }],
            assignees: [],
            html_url: "https://github.com/test/repo/issues/1",
            created_at: "2023-01-01T00:00:00Z",
            updated_at: "2023-01-01T00:00:00Z",
          },
        ])
      );

      const mockOctokitForStatusTest = {
        rest: {
          issues: {
            get: mock(() =>
              Promise.resolve({
                data: {
                  labels: [{ name: "minsky:todo", color: "d73a4a" }],
                },
              })
            ),
            // update returns labels WITHOUT minsky:planning (simulating a GitHub API quirk
            // or a missing label on the repo)
            update: mock(() =>
              Promise.resolve({
                data: {
                  labels: [{ name: "minsky:todo", color: "d73a4a" }],
                },
              })
            ),
          },
        },
        // paginate is required so setTaskStatus's internal getTask call succeeds
        paginate: mockIssuesListFail,
      };

      const backendForStatusTest = createGitHubIssuesTaskBackend({
        name: "github",
        workspacePath: "/test/workspace",
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        octokit: mockOctokitForStatusTest as any,
        createGitHubLabelsFn: mockCreateGitHubLabels,
      }) as GitHubIssuesTaskBackend;

      // setTaskStatus must throw because the expected label wasn't in the response
      await expect(backendForStatusTest.setTaskStatus("gh#1", "PLANNING")).rejects.toThrow(
        /Status write verification failed/
      );
    });

    test("setTaskStatus succeeds when label is confirmed in GitHub response", async () => {
      // Positive case: when GitHub echoes back the correct label, no error is thrown.
      const mockOctokitSuccess = {
        rest: {
          issues: {
            get: mock(() =>
              Promise.resolve({
                data: {
                  labels: [{ name: "minsky:todo", color: "d73a4a" }],
                },
              })
            ),
            update: mock(() =>
              Promise.resolve({
                data: {
                  labels: [{ name: "minsky:planning", color: "0075ca" }],
                },
              })
            ),
          },
        },
      };

      // Seed the listForRepo used by getTask:
      const mockIssuesListForRepo = mock(() =>
        Promise.resolve([
          {
            id: 1,
            number: 1,
            title: "Task in todo",
            body: "",
            state: "open",
            labels: [{ name: "minsky:todo", color: "d73a4a" }],
            assignees: [],
            html_url: "https://github.com/test/repo/issues/1",
            created_at: "2023-01-01T00:00:00Z",
            updated_at: "2023-01-01T00:00:00Z",
          },
        ])
      );

      const octokitWithList = {
        ...mockOctokitSuccess,
        paginate: mockIssuesListForRepo,
      };

      const backendSuccess = createGitHubIssuesTaskBackend({
        name: "github",
        workspacePath: "/test/workspace",
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        octokit: octokitWithList as any,
        createGitHubLabelsFn: mockCreateGitHubLabels,
      }) as GitHubIssuesTaskBackend;

      // Should NOT throw
      await expect(backendSuccess.setTaskStatus("gh#1", "PLANNING")).resolves.toBeUndefined();
    });
  });
});
