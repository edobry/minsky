/**
 * GitHub API Integration Tests
 *
 * These tests verify GitHub API connectivity and basic operations.
 * They run against the real GitHub API and require:
 * 1. GITHUB_TOKEN environment variable set
 * 2. Access to a test repository
 * 3. Network connectivity
 *
 * Run with: bun test tests/integration/github-api.integration.test.ts
 *
 * NOTE: These tests are NOT part of the main test suite and must be run explicitly.
 * They will create and modify real GitHub issues in the test repository.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Octokit } from "@octokit/rest";
import { getGitHubBackendConfig } from "../src/domain/tasks/githubBackendConfig";

// Integration test configuration
const INTEGRATION_CONFIG = {
  // Use environment variables for test configuration
  owner: process.env.GITHUB_TEST_OWNER || "edobry",
  repo: process.env.GITHUB_TEST_REPO || "minsky-test",
  token: process.env.GITHUB_TOKEN,

  // Test issue prefix to identify test issues
  testPrefix: "[MINSKY-INTEGRATION-TEST]",
};

describe.skipIf(!INTEGRATION_CONFIG.token)("GitHub API Integration Tests", () => {
  let octokit: Octokit;
  let createdIssueNumbers: number[] = [];

  beforeAll(async () => {
    console.log("🔍 Setting up GitHub API integration tests...");
    console.log(`   Repository: ${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}`);

    // Create Octokit instance
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

        console.log(`   Closed test issue #${issueNumber}`);
      } catch (error: any) {
        console.warn(`   Failed to cleanup issue #${issueNumber}: ${error.message}`);
      }
    }

    console.log("✅ Integration test cleanup completed");
  });

  describe("Authentication", () => {
    test("should authenticate successfully", async () => {
      const { data: user } = await octokit.rest.users.getAuthenticated();

      expect(user).toBeDefined();
      expect(user.login).toBeTruthy();

      console.log(`✅ Authenticated as: ${user.login}`);
    });

    test("should have sufficient rate limit", async () => {
      const { data: rateLimit } = await octokit.rest.rateLimit.get();

      expect(rateLimit.resources.core.remaining).toBeGreaterThan(10);

      console.log(
        `✅ Rate limit: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit}`
      );
    });
  });

  describe("Repository Access", () => {
    test("should access test repository", async () => {
      const { data: repo } = await octokit.rest.repos.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
      });

      expect(repo).toBeDefined();
      expect(repo.full_name).toBe(`${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}`);
      expect(repo.permissions?.push).toBe(true); // Need write access
    });

    test("should list repository issues", async () => {
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        per_page: 10,
      });

      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe("Issue Operations", () => {
    test("should create a new issue", async () => {
      const issueData = {
        title: `${INTEGRATION_CONFIG.testPrefix} Basic Issue Creation`,
        body: "This is a test issue created by GitHub API integration tests.",
        labels: ["minsky:todo"],
      };

      const { data: issue } = await octokit.rest.issues.create({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        ...issueData,
      });

      expect(issue).toBeDefined();
      expect(issue.number).toBeTruthy();
      expect(issue.title).toBe(issueData.title);
      expect(issue.body).toBe(issueData.body);
      expect(issue.state).toBe("open");

      createdIssueNumbers.push(issue.number);
    });

    test("should update issue labels", async () => {
      // Create an issue first
      const { data: issue } = await octokit.rest.issues.create({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        title: `${INTEGRATION_CONFIG.testPrefix} Label Update Test`,
        body: "Testing label updates",
        labels: ["minsky:todo"],
      });

      createdIssueNumbers.push(issue.number);

      // Update labels
      const { data: updatedIssue } = await octokit.rest.issues.update({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        issue_number: issue.number,
        labels: ["minsky:in-progress"],
      });

      const labelNames = updatedIssue.labels.map((label) =>
        typeof label === "string" ? label : label.name
      );

      expect(labelNames).toContain("minsky:in-progress");
      expect(labelNames).not.toContain("minsky:todo");
    });

    test("should retrieve issue by number", async () => {
      // Create an issue first
      const { data: createdIssue } = await octokit.rest.issues.create({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        title: `${INTEGRATION_CONFIG.testPrefix} Retrieval Test`,
        body: "Testing issue retrieval",
      });

      createdIssueNumbers.push(createdIssue.number);

      // Retrieve the issue
      const { data: retrievedIssue } = await octokit.rest.issues.get({
        owner: INTEGRATION_CONFIG.owner,
        repo: INTEGRATION_CONFIG.repo,
        issue_number: createdIssue.number,
      });

      expect(retrievedIssue.number).toBe(createdIssue.number);
      expect(retrievedIssue.title).toBe(createdIssue.title);
      expect(retrievedIssue.body).toBe(createdIssue.body);
    });
  });

  describe("Label Management", () => {
    test("should create Minsky labels if they don't exist", async () => {
      const requiredLabels = [
        { name: "minsky:todo", color: "0052cc", description: "Minsky task status: TODO" },
        {
          name: "minsky:in-progress",
          color: "fbca04",
          description: "Minsky task status: In Progress",
        },
        { name: "minsky:in-review", color: "d4c5f9", description: "Minsky task status: In Review" },
        { name: "minsky:done", color: "0e8a16", description: "Minsky task status: Done" },
        { name: "minsky:blocked", color: "d93f0b", description: "Minsky task status: Blocked" },
        { name: "minsky:closed", color: "6a737d", description: "Minsky task status: Closed" },
      ];

      for (const labelSpec of requiredLabels) {
        try {
          // Try to get the label
          await octokit.rest.issues.getLabel({
            owner: INTEGRATION_CONFIG.owner,
            repo: INTEGRATION_CONFIG.repo,
            name: labelSpec.name,
          });

          console.log(`✅ Label exists: ${labelSpec.name}`);
        } catch (error: any) {
          if (error.status === 404) {
            // Label doesn't exist, create it
            try {
              await octokit.rest.issues.createLabel({
                owner: INTEGRATION_CONFIG.owner,
                repo: INTEGRATION_CONFIG.repo,
                ...labelSpec,
              });

              console.log(`✅ Created label: ${labelSpec.name}`);
            } catch (createError: any) {
              console.warn(`⚠️  Failed to create label ${labelSpec.name}: ${createError.message}`);
            }
          } else {
            throw error;
          }
        }
      }
    });
  });

  describe("GitHub Backend Config", () => {
    test("should detect GitHub repository configuration", async () => {
      // Test the GitHub backend config detection
      const config = getGitHubBackendConfig("/mock/projects/minsky");

      if (config) {
        expect(config.owner).toBeTruthy();
        expect(config.repo).toBeTruthy();
        expect(config.githubToken).toBeTruthy();

        console.log(`✅ GitHub config detected: ${config.owner}/${config.repo}`);
      } else {
        console.log(
          "⚠️  No GitHub repository detected (this is normal for some test environments)"
        );
      }
    });

    test("should handle token environment variables", async () => {
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

      expect(githubToken).toBeTruthy();

      if (githubToken) {
        expect(
          githubToken.startsWith("ghp_") ||
            githubToken.startsWith("gho_") ||
            githubToken.startsWith("ghs_")
        ).toBe(true);
        console.log(`✅ GitHub token format valid: ${githubToken.substring(0, 4)}...`);
      }
    });
  });

  describe("Error Handling", () => {
    test("should handle non-existent issue gracefully", async () => {
      const nonExistentIssueNumber = 999999;

      try {
        await octokit.rest.issues.get({
          owner: INTEGRATION_CONFIG.owner,
          repo: INTEGRATION_CONFIG.repo,
          issue_number: nonExistentIssueNumber,
        });

        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.status).toBe(404);
        console.log("✅ Properly handled non-existent issue");
      }
    });

    test("should handle invalid repository gracefully", async () => {
      try {
        await octokit.rest.repos.get({
          owner: "non-existent-owner-12345",
          repo: "non-existent-repo-12345",
        });

        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.status).toBe(404);
        console.log("✅ Properly handled non-existent repository");
      }
    });
  });
});

// Helper function to run integration tests
export async function runGitHubIntegrationTests(): Promise<void> {
  console.log("🧪 Running GitHub API Integration Tests");
  console.log("⚠️  These tests will create and modify real GitHub issues");
  console.log(`📋 Configuration:`);
  console.log(`   Repository: ${INTEGRATION_CONFIG.owner}/${INTEGRATION_CONFIG.repo}`);
  console.log(`   Token: ${INTEGRATION_CONFIG.token ? "Configured" : "Missing"}`);
  console.log("");

  if (!INTEGRATION_CONFIG.token) {
    console.error("❌ GITHUB_TOKEN environment variable is required");
    console.error('   Set it with: export GITHUB_TOKEN="your_token_here"');
    throw new Error("GitHub token not configured");
  }

  console.log("🚀 Starting integration tests...");
}
