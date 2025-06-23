import { createTaskServiceWithGitHub, createTaskService } from "./src/domain/tasks/taskService";

async function testGitHubBackendIntegration() {
  console.log("🔍 Testing GitHub Backend Integration...\n");

  try {
    // Test 1: Create service with GitHub backend
    console.log("1. Testing GitHub backend initialization...");
    const githubService = await createTaskServiceWithGitHub({ 
      backend: "github-issues",
      workspacePath: "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#138"
    });

    console.log("✅ GitHub service created successfully");
    console.log("Available backends:", githubService.getAvailableBackends());

    // Test 2: List tasks from GitHub
    console.log("\n2. Testing GitHub task listing...");
    const tasks = await githubService.listTasks();
    console.log(`✅ Listed ${tasks.length} tasks from GitHub Issues backend`);

    if (tasks.length > 0) {
      console.log("Recent GitHub tasks:");
      tasks.slice(0, 3).forEach((task, index) => {
        console.log(`   ${index + 1}. ${task.id}: ${task.title} [${task.status}]`);
      });
    }

    // Test 3: Verify backend switching works
    console.log("\n3. Testing backend switching...");
    const regularService = createTaskService({ 
      workspacePath: "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#138"
    });
    console.log("Default backends:", regularService.getAvailableBackends());

    await regularService.switchBackend("github-issues");
    console.log("✅ Successfully switched to GitHub backend");

    console.log("\n🎉 All tests passed! GitHub backend is fully integrated!");

  } catch (error) {
    console.log(`❌ Integration test failed: ${error}`);
    
    if (String(error).includes("Backend 'github-issues' not found")) {
      console.log("   → GitHub backend is not being loaded properly");
      console.log("   → Check if .env file has GITHUB_TOKEN");
    } else if (String(error).includes("401")) {
      console.log("   → GitHub token authentication failed");
    } else if (String(error).includes("404")) {
      console.log("   → Repository not found or no access");
    }
  }
}

// Run the integration test
testGitHubBackendIntegration().catch(console.error); 
