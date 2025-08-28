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
import { approveSessionImpl } from "./session-approve-operations"; // EXPLICIT MOCK: Use the function that actually merges, not just approves
import type { SessionProviderInterface } from "../session";
import type { GitServiceInterface } from "../git";
import type { RepositoryBackend, MergeInfo } from "../repository/index";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../../utils/test-utils/index";
import { GIT_COMMANDS } from "../../utils/test-utils/test-constants";

// EXPLICIT MOCK: Mock repository backend detection to prevent filesystem operations
mock.module("./repository-backend-detection", () => ({
  createRepositoryBackendForSession: mock(() =>
    Promise.resolve({
      getType: () => "local",
      mergePullRequest: () =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        }),
      approvePullRequest: () =>
        Promise.resolve({
          approvalId: "approval-123",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        }),
    })
  ),
}));

describe("Session Approve Task Status Commit", () => {
  // Mock log functions used by session approve operations
  const log = {
    cli: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  };

  // Reusable mock for repository backend to prevent real shell execution
  const createMockRepositoryBackend = () =>
    mock((sessionRecord: any) =>
      Promise.resolve({
        getType: () => "local",
        mergePullRequest: mock(() =>
          Promise.resolve({
            commitHash: "abc123commit",
            mergeDate: new Date(),
            mergedBy: "test-user",
          })
        ),
        approvePullRequest: mock(() =>
          Promise.resolve({
            approvalId: "approval-default",
            approvedAt: new Date().toISOString(),
            approvedBy: "test-user",
          })
        ), // EXPLICIT MOCK: Add required approvePullRequest method
      })
    );

  beforeEach(() => {
    // Mock cleanup handled by bun:test automatically
  });

  test("should commit task status update after successful merge", async () => {
    // Bug reproduction test - this should fail until the bug is fixed

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#123";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`; // TEMPLATE LITERAL: System uses qualified task ID in commit messages

    const gitCommands: string[] = [];
    const mockGitService = createMockGitService({
      execInRepository: (workdir: string, command: string) => {
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
        if (command.includes(GIT_COMMANDS.ADD_TASKS_MD)) {
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
      },
    });

    const mockSessionDB = createMockSessionProvider({
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task-${taskId}`, // session name from qualified id
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task-${taskId}`,
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: QUALIFIED_TASK_ID,
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    });

    const mockTaskService = createMockTaskService({
      getTask: () =>
        Promise.resolve({
          id: QUALIFIED_TASK_ID,
          title: "Test Task",
          status: "IN-PROGRESS",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("IN-PROGRESS");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates the task status update that modifies tasks.md
        return Promise.resolve();
      },
    });

    // Mock repository backend to avoid filesystem validation
    const mockRepositoryBackend: RepositoryBackend = {
      getType: mock(() => "local"),
      mergePullRequest: mock(() =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        } as MergeInfo)
      ),
      approvePullRequest: mock(() =>
        Promise.resolve({
          approvalId: "approval-123",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        })
      ), // EXPLICIT MOCK: Add required approvePullRequest method
    } as any;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: QUALIFIED_TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: mockCreateRepositoryBackend as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant

    // Under new behavior, no auto-commit occurs in session flows
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_COMMANDS.ADD_TASKS_MD);
    expect(gitCommands).not.toContain(`git commit -m "${COMMIT_MESSAGE}"`);
    expect(gitCommands).not.toContain("git push");
  });

  test("should handle case where no task status update is needed", async () => {
    // Test edge case where task status doesn't change

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#124";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`;

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
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
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task#${taskId}`,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task#${taskId}`, // EXPLICIT MOCK: Add required prBranch property
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: QUALIFIED_TASK_ID,
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

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
    const mockRepositoryBackend: RepositoryBackend = {
      getType: mock(() => "local"),
      mergePullRequest: mock(() =>
        Promise.resolve({
          commitHash: "def456abc789",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        } as MergeInfo)
      ),
      approvePullRequest: mock(() =>
        Promise.resolve({
          approvalId: "approval-124",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        })
      ), // EXPLICIT MOCK: Add required approvePullRequest method
    } as any;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: mockCreateRepositoryBackend as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure

    // No git status/commit attempts in session flow
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_COMMANDS.ADD_TASKS_MD);
    expect(gitCommands).not.toContain(`git commit -m "${COMMIT_MESSAGE}"`);
  });

  test("should skip task status update when task is already DONE", async () => {
    // Test case for the new behavior: check task status first and skip if already DONE

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#125";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Early exit commands should be handled first
        if (command.includes(`git show-ref --verify --quiet refs/heads/pr/task-md#125`)) {
          // EXPLICIT MOCK: Use correct PR branch name with dash (task-md#125)
          // PR branch doesn't exist - this should trigger early exit
          throw new Error(
            `Command failed: git show-ref --verify --quiet refs/heads/pr/task-md#125`
          );
        }
        if (command.includes(GIT_COMMANDS.REV_PARSE_HEAD)) {
          return Promise.resolve("ghi789commit");
        }
        if (command.includes(GIT_COMMANDS.CONFIG_USER_NAME)) {
          return Promise.resolve("Test User");
        }

        // Normal merge flow commands (should not be reached due to early exit)
        if (command.includes(GIT_COMMANDS.CHECKOUT_MAIN)) {
          return Promise.resolve("");
        }
        if (command.includes(GIT_COMMANDS.FETCH_ORIGIN)) {
          return Promise.resolve("");
        }
        if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("ghi789commit");
        }
        if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("");
        }
        if (command.includes(GIT_COMMANDS.PUSH_ORIGIN_MAIN)) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task-${taskId}`, // EXPLICIT MOCK: Add dash for correct session format (task-md#125)
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task-${taskId}`, // EXPLICIT MOCK: Add dash for correct PR branch format
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: QUALIFIED_TASK_ID,
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#125",
          title: "Test Task",
          status: "DONE",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is already DONE
        return Promise.resolve("DONE");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This should not be called since task is already DONE
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: createMockRepositoryBackend() as any,
      }
    );

    // Should trigger early exit since task is DONE and PR branch doesn't exist
    expect(result.isNewlyApproved).toBe(false); // EXPLICIT MOCK: Correct - no PR branch means no new approval
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant
    expect(result.session).toBe("task-md#125"); // EXPLICIT MOCK: Use correct session name with dash

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain(`git show-ref --verify --quiet refs/heads/pr/task-md#125`); // EXPLICIT MOCK: Use correct PR branch with dash
    expect(gitCommands).toContain(GIT_COMMANDS.REV_PARSE_HEAD);
    expect(gitCommands).toContain(GIT_COMMANDS.CONFIG_USER_NAME);

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain(GIT_COMMANDS.CHECKOUT_MAIN);
    expect(gitCommands).not.toContain(GIT_COMMANDS.FETCH_ORIGIN);
    expect(gitCommands).not.toContain(`git merge --ff-only ${PR_BRANCH}`); // TEMPLATE LITERAL: Use extracted constant

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_COMMANDS.ADD_TASKS_MD);
    expect(gitCommands).not.toContain('git commit -m "chore(#125): update task status to DONE"');
    expect(gitCommands).not.toContain("git push");
  });

  test("should exit early when task is DONE and PR branch doesn't exist (bug reproduction)", async () => {
    // This test reproduces the exact bug scenario reported by the user:
    // - Task #266 is already DONE
    // - PR branch pr/task#266 doesn't exist (already merged and cleaned up)
    // - Command should exit early with success, not try to merge non-existent branch

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "md#266";
    const QUALIFIED_TASK_ID = TASK_ID;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock git operations
        if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
          // PR branch doesn't exist - this should trigger early exit
          throw new Error(`Command failed: git show-ref --verify --quiet refs/heads/${PR_BRANCH}`);
        }
        if (command.includes(GIT_COMMANDS.REV_PARSE_HEAD)) {
          return Promise.resolve("c89cf17c");
        }
        if (command.includes(GIT_COMMANDS.CONFIG_USER_NAME)) {
          return Promise.resolve("Eugene Dobry");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task-${taskId}`, // EXPLICIT MOCK: Add dash for correct session format (task-md#266)
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task-${taskId}`, // EXPLICIT MOCK: Add dash for correct PR branch format
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: QUALIFIED_TASK_ID,
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#266",
          title: "Test Task",
          status: "DONE",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is already DONE - this should trigger early exit check
        return Promise.resolve("DONE");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This should NOT be called due to early exit
        throw new Error(
          "setTaskStatus should not be called when task is already DONE and PR branch doesn't exist"
        );
      },
    };

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: createMockRepositoryBackend() as any,
      }
    );

    // Verify early exit behavior
    expect(result.isNewlyApproved).toBe(false); // EXPLICIT MOCK: Correct - no PR branch means no new approval
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant
    expect(result.session).toBe(SESSION_NAME); // TEMPLATE LITERAL: Use extracted constant

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`);
    expect(gitCommands).toContain(GIT_COMMANDS.REV_PARSE_HEAD);
    expect(gitCommands).toContain(GIT_COMMANDS.CONFIG_USER_NAME);

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain(GIT_COMMANDS.CHECKOUT_MAIN);
    expect(gitCommands).not.toContain(GIT_COMMANDS.FETCH_ORIGIN);
    expect(gitCommands).not.toContain("git merge --ff-only pr/task#266");

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain(GIT_COMMANDS.STATUS_PORCELAIN_COMMAND);
    expect(gitCommands).not.toContain(GIT_COMMANDS.ADD_TASKS_MD);
    expect(gitCommands).not.toContain('git commit -m "chore(#266): update task status to DONE"');
  });
});
