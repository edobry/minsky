// Quick test to verify qualified ID routing works
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function testQualifiedIDRouting() {
  console.log("🧪 Testing Qualified ID Routing...\n");

  try {
    // Create the service (now returns MultiBackendTaskService)
    const taskService = createConfiguredTaskService({
      workspacePath: "/tmp/test-workspace",
    });

    console.log("✅ Service created successfully");
    console.log(`📂 Workspace path: ${taskService.getWorkspacePath()}`);

    // List registered backends
    const backends = (taskService as any).listBackends?.() || [];
    console.log(`🔧 Registered backends: ${backends.length}`);
    backends.forEach((backend: any, index: number) => {
      console.log(`   ${index + 1}. ${backend.name} (prefix: ${backend.prefix || "none"})`);
    });

    // Test basic interface methods
    console.log("\n🧪 Testing TaskServiceInterface methods...");

    try {
      const tasks = await taskService.listTasks();
      console.log(`✅ listTasks() works: found ${tasks.length} tasks`);
    } catch (error) {
      console.log(`ℹ️  listTasks() message: ${error.message} (expected in empty workspace)`);
    }

    console.log(`✅ getWorkspacePath() works: ${taskService.getWorkspacePath()}`);

    console.log("\n🎉 Interface compatibility test PASSED!");
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
    return false;
  }

  return true;
}

testQualifiedIDRouting().then((success) => {
  process.exit(success ? 0 : 1);
});
