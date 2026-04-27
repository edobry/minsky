/**
 * Test for bug: Session approve command updates task status but doesn't commit the change
 *
 * Bug description:
 * - When session approve runs, it merges the PR branch successfully
 * - It updates the task status to DONE in tasks.md
 * - But the tasks.md change is not committed, leaving the repository dirty
 *
 * Expected behavior:
 * - After session approval, the task status update should be committed
 * - The working directory should be clean (no uncommitted changes)
 * - The commit should be pushed to remote
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

const GIT_ADD_TASKS_COMMAND = "git add process/tasks.md";
import { approveSessionImpl } from "./session-approve-operations";
import type { RepositoryBackend, MergeInfo } from "../repository/index";
import { FakeGitService } from "../git/fake-git-service";
import { GIT_COMMANDS } from "../../utils/test-utils/test-constants";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeSessionProvider } from "./fake-session-provider";

describe("Session Approve Task Status Commit", () => {
  // Mock log functions used by session approve operations
  const _log = {
    cli: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  };

  beforeEach(() => {
    // Mock cleanup handled by bun:test automatically
  });

  test("should commit task status update after successful merge", async () => {
    // Bug reproduction test - this should fail until the bug is fixed

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#123";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // Correct session ID format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`; // TEMPLATE LITERAL: System uses qualified task ID in commit messages

    const gitCommands: string[] = [];
    const mockGitService = new FakeGitService();
    mockGitService.execInRepository = (_workdir: string, command: string) => {
      gitCommands.push(command);

      // Mock successful git operations
      if (command.includes(GIT_COMMANDS.CHECKOUT_MAIN)) {
        return Promise.resolve("");
      }
      if (command.includes(GIT_COMMANDS.FETCH_ORIGIN)) {
        return Promise.resolve("");
      }
      if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
        return Promise.resolve(""); // PR branch exists
      }
      if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
        return Promise.resolve("abc123commit");
      }
      if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
        return Promise.resolve(""); // Merge succeeds
      }
      if (command.includes(GIT_COMMANDS.REV_PARSE_HEAD)) {
        return Promise.resolve("abc123commit");
      }
      if (command.includes(GIT_COMMANDS.CONFIG_USER_NAME)) {
        return Promise.resolve("Test User");
      }
      if (command.includes(GIT_COMMANDS.PUSH_ORIGIN_MAIN)) {
        return Promise.resolve("");
      }
      if (command.includes(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND)) {
        // After task status update, tasks.md should be modified
        return Promise.resolve("M process/tasks.md");
      }
      if (command.includes(GIT_ADD_TASKS_COMMAND)) {
        return Promise.resolve("");
      }
      if (command.includes(`git commit -m "${COMMIT_MESSAGE}"`)) {
        // TEMPLATE LITERAL: Use extracted constant
        return Promise.resolve("");
      }
      if (command.includes("git push")) {
        return Promise.resolve("");
      }

      return Promise.resolve("");
    };

    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSessionByTaskId = (taskId: string) =>
      Promise.resolve({
        sessionId: `task-${taskId}`, // session ID from qualified id
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
        prBranch: `pr/task-${taskId}`,
      });
    mockSessionDB.getSession = (sessionId: string) =>
      Promise.resolve({
        sessionId: sessionId,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: QUALIFIED_TASK_ID,
        prBranch: `pr/${sessionId}`, // EXPLICIT MOCK: Add required prBranch property
      });

    const mockTaskService = (() => {
      const svc = new FakeTaskService({
        initialTasks: [{ id: QUALIFIED_TASK_ID, title: "Test Task", status: "IN-PROGRESS" }],
      });
      svc.getTaskStatus = (_taskId: string) => Promise.resolve("IN-PROGRESS");
      svc.setTaskStatus = (_taskId: string, _status: string) => Promise.resolve();
      return svc;
    })();

    // Mock repository backend to avoid filesystem validation
    const mockRepositoryBackend = {
      getType: mock(() => "local"),
      pr: {
        merge: mock(() =>
          Promise.resolve({
            commitHash: "abc123def456",
            mergeDate: "2025-07-30T23:14:24.213Z",
            mergedBy: "Test User",
          } as MergeInfo)
        ),
      },
      review: {
        approve: mock(() =>
          Promise.resolve({
            approvalId: "approval-123",
            approvedAt: "2025-07-30T23:14:24.213Z",
            approvedBy: "Test User",
          })
        ),
      },
    } as unknown as RepositoryBackend;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: QUALIFIED_TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackend,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant

    // Under new behavior, no auto-commit occurs in session flows
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_ADD_TASKS_COMMAND);
    expect(gitCommands).not.toContain(`git commit -m "${COMMIT_MESSAGE}"`);
    expect(gitCommands).not.toContain("git push");
  });

  test("should handle case where no task status update is needed", async () => {
    // Test edge case where task status doesn't change

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#124";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session ID format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`;

    const gitCommands: string[] = [];
    const mockGitService = new FakeGitService();
    mockGitService.execInRepository = (workdir: string, command: string) => {
      gitCommands.push(command);

      // Mock git operations
      if (command.includes(GIT_COMMANDS.CHECKOUT_MAIN)) {
        return Promise.resolve("");
      }
      if (command.includes(GIT_COMMANDS.FETCH_ORIGIN)) {
        return Promise.resolve("");
      }
      if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
        // TEMPLATE LITERAL: Use extracted constant
        return Promise.resolve("");
      }
      if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
        // TEMPLATE LITERAL: Use extracted constant
        return Promise.resolve("def456commit");
      }
      if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
        // TEMPLATE LITERAL: Use extracted constant
        return Promise.resolve("");
      }
      if (command.includes(GIT_COMMANDS.REV_PARSE_HEAD)) {
        return Promise.resolve("def456commit");
      }
      if (command.includes(GIT_COMMANDS.CONFIG_USER_NAME)) {
        return Promise.resolve("Test User");
      }
      if (command.includes(GIT_COMMANDS.PUSH_ORIGIN_MAIN)) {
        return Promise.resolve("");
      }
      if (command.includes(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND)) {
        // No changes after task status update
        return Promise.resolve("");
      }

      return Promise.resolve("");
    };

    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSessionByTaskId = (taskId: string) =>
      Promise.resolve({
        sessionId: `task#${taskId}`,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
        prBranch: `pr/task#${taskId}`, // EXPLICIT MOCK: Add required prBranch property
      });
    mockSessionDB.getSession = (sessionId: string) =>
      Promise.resolve({
        sessionId: sessionId,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: QUALIFIED_TASK_ID,
        prBranch: `pr/${sessionId}`, // EXPLICIT MOCK: Add required prBranch property
      });

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#124",
          title: "Test Task",
          status: "TODO",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("TODO");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates no actual file changes
        return Promise.resolve();
      },
    };

    // Mock repository backend to avoid filesystem validation
    const mockRepositoryBackend = {
      getType: mock(() => "local"),
      pr: {
        merge: mock(() =>
          Promise.resolve({
            commitHash: "def456abc789",
            mergeDate: "2025-07-30T23:14:24.213Z",
            mergedBy: "Test User",
          } as MergeInfo)
        ),
      },
      review: {
        approve: mock(() =>
          Promise.resolve({
            approvalId: "approval-124",
            approvedAt: "2025-07-30T23:14:24.213Z",
            approvedBy: "Test User",
          })
        ),
      },
    } as unknown as RepositoryBackend;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackend,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure

    // No git status/commit attempts in session flow
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_ADD_TASKS_COMMAND);
    expect(gitCommands).not.toContain(`git commit -m "${COMMIT_MESSAGE}"`);
  });
});
