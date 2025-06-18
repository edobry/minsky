#!/usr/bin/env bun

/**
 * Direct test script for GitHub Issues Task Backend
 *
 * This script tests the GitHub backend functionality directly
 * without going through the main TaskService integration.
 */

import { createGitHubIssuesTaskBackend } from "./src/domain/tasks/githubIssuesTaskBackend";
import { getGitHubBackendConfig } from "./src/domain/tasks/githubBackendConfig";

async function testGitHubBackend() {
  console.log("🔍 Testing GitHub Issues Task Backend...\n");

  // Step 1: Check configuration
  console.log("1. Checking GitHub configuration...");
  const config = getGitHubBackendConfig(process.cwd());

  if (!config) {
    console.log("❌ No GitHub configuration found. Please create a .env file with:");
    console.log("   GITHUB_TOKEN=your_token_here");
    console.log("\nGet your token from: https://github.com/settings/tokens");
    console.log("Required scopes: repo, issues");
    return;
  }

  console.log("✅ GitHub configuration found");
  console.log(`   Repository: ${config.owner}/${config.repo}`);
  console.log(`   Token: ${config.token ? `***${config.token.slice(-4)}` : "not set"}\n`);

  // Step 2: Create backend instance
  console.log("2. Creating GitHub backend instance...");
  try {
    const backend = createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath: process.cwd(),
      ...config,
    });
    console.log("✅ Backend instance created\n");

    // Step 3: Test listing tasks (GitHub issues)
    console.log("3. Testing task listing...");
    const tasksResult = await backend.getTasksData();

    if (tasksResult.success) {
      const tasks = backend.parseTasks(tasksResult.content);
      console.log(`✅ Found ${tasks.length} tasks/issues`);

      if (tasks.length > 0) {
        console.log("   Recent tasks:");
        tasks.slice(0, 3).forEach((task) => {
          console.log(`   - ${task.id}: ${task.title} [${task.status}]`);
        });
      }
    } else {
      console.log(`❌ Failed to list tasks: ${tasksResult.error?.message}`);
    }
  } catch (error) {
    console.log(`❌ Error creating backend: ${error.message}`);
    if (error.message.includes("401")) {
      console.log("   → Check your GitHub token permissions");
    } else if (error.message.includes("404")) {
      console.log("   → Check if the repository exists and you have access");
    }
  }

  console.log("\n🎉 Test complete!");
}

// Run the test
testGitHubBackend().catch(console.error);
