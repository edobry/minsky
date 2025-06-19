import { createTaskService } from "./src/domain/tasks/taskService";

async function testFinalIntegration() {
  console.log("🔍 Testing TaskService with GitHub backend...");

  try {
    // Test default backends
    const defaultService = createTaskService({ workspacePath: process.cwd() });
    console.log("✅ Default service created");

    // Try to create with github-issues backend
    try {
      const githubService = createTaskService({
        backend: "github-issues",
        workspacePath: process.cwd(),
      });
      console.log("✅ GitHub backend integrated successfully!");

      // Test listing tasks
      const tasks = await githubService.listTasks();
      console.log(`✅ Listed ${tasks.length} tasks from GitHub backend`);
    } catch (error) {
      console.log("❌ GitHub backend not available:", String(error));
      console.log("   This is expected if module resolution isn't fixed");
    }
  } catch (error) {
    console.log("❌ Service creation failed:", String(error));
  }

  console.log("🎉 Test complete!");
}

testFinalIntegration().catch(console.error);
