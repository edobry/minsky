import { createGitHubIssuesTaskBackend } from "./src/domain/tasks/githubIssuesTaskBackend";
import { getGitHubBackendConfig } from "./src/domain/tasks/githubBackendConfig";

async function testGitHubIntegration() {
  console.log("🔍 Testing GitHub Issues Task Backend Integration...\n");

  // Load configuration
  const config = getGitHubBackendConfig(process.cwd());
  if (!config) {
    console.log("❌ No GitHub configuration found");
    console.log("   Make sure you have GITHUB_TOKEN in your .env file");
    return;
  }

  console.log("✅ Configuration loaded:");
  console.log(`   Repository: ${config.owner}/${config.repo}`);
  console.log(
    `   Token: ${config.token ? `${config.token.slice(0, 4)}***${config.token.slice(-4)}` : "not set"}\n`
  );

  // Create backend instance
  const backend = createGitHubIssuesTaskBackend({
    name: "github-issues",
    workspacePath: process.cwd(),
    ...config,
  });

  console.log("✅ Backend created successfully\n");

  // Test listing tasks/issues
  console.log("🔍 Testing issue listing...");
  const result = await backend.getTasksData();

  if (result.success) {
    const tasks = backend.parseTasks(result.content);
    console.log(`✅ Successfully fetched ${tasks.length} tasks/issues`);

    if (tasks.length > 0) {
      console.log("\nRecent tasks:");
      tasks.slice(0, 5).forEach((task, index) => {
        console.log(`   ${index + 1}. ${task.id}: ${task.title} [${task.status}]`);
      });
    } else {
      console.log("   No issues found with Minsky labels");
    }
  } else {
    console.log(`❌ Failed to fetch tasks: ${result.error?.message}`);

    if (result.error?.message.includes("401")) {
      console.log("   → Check your GitHub token permissions");
    } else if (result.error?.message.includes("404")) {
      console.log("   → Check if the repository exists and you have access");
    }
  }

  console.log("\n🎉 Integration test complete!");
}

// Run the test
testGitHubIntegration().catch(console.error);
