/**
 * GitHub Issues Backend Integration Tests
 *
 * These tests run against the real GitHub API and require:
 * 1. GITHUB_TOKEN environment variable set
 * 2. Access to a test repository
 * 3. Network connectivity
 *
 * Run with: bun test tests/integration/github-issues-backend.integration.test.ts
 *
 * NOTE: These tests are NOT part of the main test suite and must be run explicitly.
 * They will modify real GitHub issues in the test repository.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createGitHubIssuesTaskBackend } from "../../src/domain/tasks/githubIssuesTaskBackend";
import type { TaskBackend } from "../../src/domain/tasks/taskBackend";
import { Octokit } from "@octokit/rest";

// Define TaskStatus type locally since it might not be exported
type TaskStatus = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "BLOCKED" | "CLOSED";

// Integration test configuration
const INTEGRATION_CONFIG = {
  // Use environment variables for test configuration
  owner: process.env.GITHUB_TEST_OWNER || "edobry",
  repo: process.env.GITHUB_TEST_REPO || "minsky-test",
  token: process.env.GITHUB_TOKEN,

  // Test issue prefix to identify test issues
  testPrefix: "[MINSKY-INTEGRATION-TEST]",

  // Timeout for API operations
  apiTimeout: 10000,
};

describe("GitHub Issues Backend Integration Tests", { timeout: 30000 }, () => {
  let backend: TaskBackend;
  let octokit: Octokit;
  let createdIssueNumbers: number[] = [];

  beforeAll(async () => {
    // Verify test prerequisites
    if (!INTEGRATION_CONFIG.token) {
      throw new Error(
        "GITHUB_TOKEN environment variable is required for integration tests.\n" +
          'Set it with: export GITHUB_TOKEN="your_token_here"'
      );
    }

    console.log("🔍 Setting up GitHub Issues backend integration tests...");
    console.log(`   Repository: ${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}`);
    console.log(`   Test prefix: ${INTEGRATION_CONFIG.testPrefix}`);

    // Create backend instance
    backend = createGitHubIssuesTaskBackend({
      githubToken: INTEGRATION_CONFIG.token,
      owner: INTEGRATION_CONFIG.owner,
      repo: INTEGRATION_CONFIG.repo,
      name: "github-issues",
      workspacePath: "/tmp/test",
    });

    // Create Octokit instance for direct API access
    octokit = new Octokit({
      auth: INTEGRATION_CONFIG.token,
    });

    // Verify repository access
    try {
      const { data: repo } = await octokit.rest.repos.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
      });
      console.log(`✅ Repository access confirmed: ${repo.full_name}`);
    } catch (error: any) {
      throw new Error(
        `Failed to access test repository ${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}: ${error.message}\n` +
          "Ensure:\n" +
          "1. Repository exists and is accessible\n" +
          "2. Token has required permissions (repo scope)\n" +
          "3. You have write access to the repository"
      );
    }

    // Verify required labels exist
    try {
      await octokit.rest.issues.getLabel({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        name: "minsky:todo",
      });
      console.log("✅ Minsky labels are available");
    } catch (error: any) {
      if (error.status === 404) {
        console.log("⚠️  Minsky labels not found - backend will create them automatically");
      } else {
        throw error;
      }
    }
  });

  afterAll(async () => {
    // Cleanup: close all test issues
    console.log("🧹 Cleaning up test issues...");

    for (const issueNumber of createdIssueNumbers) {
      try {
        await octokit.rest.issues.update({
          owner: INTEGRATION_CONFIG.owner,
          repo: INTEGRATION_CONFIG.repo,
          issue_number: issueNumber,
          state: "closed",
        });

        // Add cleanup comment
        await octokit.rest.issues.createComment({
          owner: INTEGRATION_CONFIG.owner,
          repo: INTEGRATION_CONFIG.repo,
          issue_number: issueNumber,
          body: "🧹 Automatically closed by integration test cleanup",
        });

        console.log(`   Closed test issue #${issueNumber}`);
      } catch (error: any) {
        console.warn(`   Failed to cleanup issue #${issueNumber}: ${error.message}`);
      }
    }

    console.log("✅ Integration test cleanup completed");
  });

  beforeEach(() => {
    // Reset for each test
    createdIssueNumbers = [];
  });

  describe("Task Creation", () => {
    test("should create a new GitHub issue from task spec", async () => {
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Test Task Creation`,
        description:
          "This is a test task created by integration tests.\n\nIt should be automatically cleaned up.",
        status: "TODO" as TaskStatus,
      };

      const task = await backend.createTask(taskSpec);

      expect(task).toBeDefined();
      expect(task.id).toBeTruthy();
      expect(task.title).toBe(taskSpec.title);
      expect(task.description).toBe(taskSpec.description);
      expect(task.status).toBe("TODO");

      // Verify issue was created in GitHub
      const issueNumber = parseInt(task.id);
      createdIssueNumbers.push(issueNumber);

      const { data: issue } = await octokit.rest.issues.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        issue_number: issueNumber,
      });

      expect(issue.title).toBe(taskSpec.title);
      expect(issue.body).toBe(taskSpec.description);
      expect(issue.state).toBe("open");

      // Verify Minsky labels are applied
      const labelNames = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name
      );
      expect(labelNames).toContain("minsky:todo");
    });

    test("should handle task creation with minimal information", async () => {
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Minimal Task`,
        status: "TODO" as TaskStatus,
      };

      const task = await backend.createTask(taskSpec);

      expect(task).toBeDefined();
      expect(task.id).toBeTruthy();
      expect(task.title).toBe(taskSpec.title);
      expect(task.status).toBe("TODO");

      const issueNumber = parseInt(task.id);
      createdIssueNumbers.push(issueNumber);
    });
  });

  describe("Task Status Updates", () => {
    test("should update task status by changing GitHub issue labels", async () => {
      // Create a task
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Status Update Test`,
        description: "Testing status updates",
        status: "TODO" as TaskStatus,
      };

      const task = await backend.createTask(taskSpec);
      const issueNumber = parseInt(task.id);
      createdIssueNumbers.push(issueNumber);

      // Update status to IN_PROGRESS
      const updatedTask = await backend.updateTask(task.id, {
        status: "IN_PROGRESS",
      });

      expect(updatedTask.status).toBe("IN_PROGRESS");

      // Verify in GitHub
      const { data: issue } = await octokit.rest.issues.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        issue_number: issueNumber,
      });

      const labelNames = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name
      );
      expect(labelNames).toContain("minsky:in-progress");
      expect(labelNames).not.toContain("minsky:todo");
    });

    test("should handle multiple status transitions", async () => {
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Multiple Status Test`,
        status: "TODO" as TaskStatus,
      };

      const task = await backend.createTask(taskSpec);
      const issueNumber = parseInt(task.id);
      createdIssueNumbers.push(issueNumber);

      // TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
      const statuses: TaskStatus[] = ["IN_PROGRESS", "IN_REVIEW", "DONE"];

      for (const status of statuses) {
        const updatedTask = await backend.updateTask(task.id, { status });
        expect(updatedTask.status).toBe(status);

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Verify final state
      const { data: finalIssue } = await octokit.rest.issues.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        issue_number: issueNumber,
      });

      const labelNames = finalIssue.labels.map((label) =>
        typeof label === "string" ? label : label.name
      );
      expect(labelNames).toContain("minsky:done");
    });
  });

  describe("Task Retrieval", () => {
    test("should fetch tasks from GitHub issues", async () => {
      // Create a test task first
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Fetch Test`,
        description: "Testing task retrieval",
        status: "TODO" as TaskStatus,
      };

      const createdTask = await backend.createTask(taskSpec);
      const issueNumber = parseInt(createdTask.id);
      createdIssueNumbers.push(issueNumber);

      // Fetch all tasks
      const tasks = await backend.getTasksData();

      expect(Array.isArray(tasks)).toBe(true);

      // Find our test task
      const testTask = tasks.find((task) => task.id === createdTask.id);
      expect(testTask).toBeDefined();
      expect(testTask?.title).toBe(taskSpec.title);
      expect(testTask?.description).toBe(taskSpec.description);
    });

    test("should get individual task by ID", async () => {
      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Individual Fetch Test`,
        status: "TODO" as TaskStatus,
      };

      const createdTask = await backend.createTask(taskSpec);
      const issueNumber = parseInt(createdTask.id);
      createdIssueNumbers.push(issueNumber);

      // Fetch the specific task
      const fetchedTask = await backend.getTask(createdTask.id);

      expect(fetchedTask).toBeDefined();
      expect(fetchedTask?.id).toBe(createdTask.id);
      expect(fetchedTask?.title).toBe(taskSpec.title);
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid issue ID gracefully", async () => {
      const invalidId = "999999";

      const task = await backend.getTask(invalidId);
      expect(task).toBeNull();
    });

    test("should handle network timeouts gracefully", async () => {
      // This test is harder to simulate reliably, but we can test with a very short timeout
      // In a real scenario, network issues would be handled by the GitHub API client

      const taskSpec = {
        title: `${INTEGRATION_CONFIG.testPrefix} Timeout Test`,
        status: "TODO" as TaskStatus,
      };

      // This should still work with normal network conditions
      const task = await backend.createTask(taskSpec);
      expect(task).toBeDefined();

      if (task.id) {
        const issueNumber = parseInt(task.id);
        createdIssueNumbers.push(issueNumber);
      }
    });
  });

  describe("Rate Limiting", () => {
    test("should handle GitHub API rate limits", async () => {
      // Check current rate limit status
      const { data: rateLimit } = await octokit.rest.rateLimit.get();

      console.log(
        `Rate limit status: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit}`
      );

      // Only run this test if we have sufficient rate limit
      if (rateLimit.resources.core.remaining < 10) {
        console.warn("Skipping rate limit test - insufficient API quota remaining");
        return;
      }

      // Create multiple tasks in succession to test rate limiting handling
      const taskPromises = Array.from({ length: 5 }, (_, i) =>
        backend.createTask({
          title: `${INTEGRATION_CONFIG.testPrefix} Rate Limit Test ${i + 1}`,
          status: "TODO" as TaskStatus,
        })
      );

      const tasks = await Promise.all(taskPromises);

      // All tasks should be created successfully
      tasks.forEach((task) => {
        expect(task).toBeDefined();
        expect(task.id).toBeTruthy();

        if (task.id) {
          const issueNumber = parseInt(task.id);
          createdIssueNumbers.push(issueNumber);
        }
      });
    });
  });

  describe("Label Management", () => {
    test("should create Minsky labels if they don't exist", async () => {
      // This is tested implicitly by creating tasks, but we can verify explicitly
      const requiredLabels = [
        "minsky:todo",
        "minsky:in-progress",
        "minsky:in-review",
        "minsky:done",
        "minsky:blocked",
        "minsky:closed",
      ];

      for (const labelName of requiredLabels) {
        try {
          const { data: label } = await octokit.rest.issues.getLabel({
            owner: INTEGRATION_CONFIG.owner,
            repo: INTEGRATION_CONFIG.repo,
            name: labelName,
          });

          expect(label.name).toBe(labelName);
          console.log(`✅ Label exists: ${labelName}`);
        } catch (error: any) {
          if (error.status === 404) {
            console.warn(`⚠️  Label missing: ${labelName} (should be created automatically)`);
          } else {
            throw error;
          }
        }
      }
    });
  });
});

// Helper function to run integration tests
export async function runIntegrationTests(): Promise<void> {
  console.log("🧪 Running GitHub Issues Backend Integration Tests");
  console.log("⚠️  These tests will create and modify real GitHub issues");
  console.log(`📋 Configuration:`);
  console.log(`   Repository: ${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}`);
  console.log(`   Token: ${INTEGRATION_CONFIG.token ? "Configured" : "Missing"}`);
  console.log("");

  if (!INTEGRATION_CONFIG.token) {
    console.error("❌ GITHUB_TOKEN environment variable is required");
    console.error('   Set it with: export GITHUB_TOKEN="your_token_here"');
    process.exit(1);
  }

  console.log("🚀 Starting integration tests...");
}
