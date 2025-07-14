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

import { describe, test, expect, beforeEach } from "bun:test";
import { approveSessionFromParams } from "./session.js";
import type { SessionProviderInterface } from "./session.js";
import type { GitServiceInterface } from "./git.js";

describe("Session Approve Task Status Commit", () => {
  test("should commit task status update after successful merge", async () => {
    // Bug reproduction test - this should fail until the bug is fixed

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock successful git operations
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#123")) {
          return Promise.resolve(""); // PR branch exists
        }
        if (command.includes("git rev-parse pr/task#123")) {
          return Promise.resolve("abc123commit");
        }
        if (command.includes("git merge --ff-only pr/task#123")) {
          return Promise.resolve(""); // Merge succeeds
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("abc123commit");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }
        if (command.includes("git status --porcelain")) {
          // After task status update, tasks.md should be modified
          return Promise.resolve("M process/tasks.md");
        }
        if (command.includes("git add process/tasks.md")) {
          return Promise.resolve("");
        }
        if (command.includes("git commit -m \"Update task #123 status to DONE\"")) {
          return Promise.resolve("");
        }
        if (command.includes("git push")) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task#${taskId}`,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "123",
      }),
    };

    const mockTaskService = {
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates the task status update that modifies tasks.md
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionFromParams(
      {
        task: "123",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true);
    expect(result.taskId).toBe("#123"); // Task ID includes the # prefix

    // BUG: These assertions will fail until the bug is fixed
    // The task status update should be committed and pushed

    // Should check git status to see if there are uncommitted changes
    expect(gitCommands).toContain("git status --porcelain");

    // Should stage the tasks.md file
    expect(gitCommands).toContain("git add process/tasks.md");

    // Should commit the task status update
    expect(gitCommands).toContain("git commit -m \"Update task #123 status to DONE\"");

    // Should push the commit
    expect(gitCommands).toContain("git push");
  });

  test("should handle case where no task status update is needed", async () => {
    // Test edge case where task status doesn't change

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock git operations
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#124")) {
          return Promise.resolve("");
        }
        if (command.includes("git rev-parse pr/task#124")) {
          return Promise.resolve("def456commit");
        }
        if (command.includes("git merge --ff-only pr/task#124")) {
          return Promise.resolve("");
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("def456commit");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }
        if (command.includes("git status --porcelain")) {
          // No changes after task status update
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task#${taskId}`,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "124",
      }),
    };

    const mockTaskService = {
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates no actual file changes
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionFromParams(
      {
        task: "124",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true);

    // Should check git status
    expect(gitCommands).toContain("git status --porcelain");

    // Should NOT try to commit when there are no changes
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain("git commit -m \"Update task #124 status to DONE\"");
  });
});
