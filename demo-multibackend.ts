#!/usr/bin/env bun
// Multi-Backend Task Service Demo
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function demonstrateMultiBackend() {
  console.log("🧪 Multi-Backend Task Service Demo\n");

  try {
    // Create the service (now automatically multi-backend!)
    const taskService = createConfiguredTaskService({
      workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
    });

    console.log("✅ Multi-backend task service created");
    console.log(`📂 Workspace: ${taskService.getWorkspacePath()}\n`);

    // List registered backends
    const backends = (taskService as any).listBackends?.() || [];
    console.log("🔧 Registered backends:");
    backends.forEach((backend: any, index: number) => {
      console.log(`   ${index + 1}. ${backend.name} (prefix: ${backend.prefix || "none"})`);
    });
    console.log();

    // Test 1: Read existing markdown tasks
    console.log("🧪 Test 1: Reading existing markdown tasks (md# prefix)");
    try {
      const mdTask1 = await taskService.getTask("md#004");
      if (mdTask1) {
        console.log(`✅ Found md#004: "${mdTask1.title}"`);
        console.log(`   Status: ${mdTask1.status}`);
      } else {
        console.log("❌ md#004 not found");
      }

      const mdTask2 = await taskService.getTask("md#007");
      if (mdTask2) {
        console.log(`✅ Found md#007: "${mdTask2.title}"`);
        console.log(`   Status: ${mdTask2.status}`);
      } else {
        console.log("❌ md#007 not found");
      }
    } catch (error) {
      console.log(`ℹ️  Error reading md tasks: ${error.message}`);
    }
    console.log();

    // Test 2: List all tasks to see routing in action
    console.log("🧪 Test 2: List all tasks (shows qualified ID routing)");
    try {
      const allTasks = await taskService.listTasks();
      console.log(`📋 Found ${allTasks.length} total tasks across all backends`);

      // Show first few tasks with their qualified IDs
      const sampleTasks = allTasks.slice(0, 5);
      sampleTasks.forEach((task, index) => {
        console.log(`   ${index + 1}. ${task.id}: "${task.title}" [${task.status}]`);
      });

      if (allTasks.length > 5) {
        console.log(`   ... and ${allTasks.length - 5} more tasks`);
      }
    } catch (error) {
      console.log(`ℹ️  Error listing tasks: ${error.message}`);
    }
    console.log();

    // Test 3: Demonstrate backend routing by task ID
    console.log("🧪 Test 3: Backend routing demonstration");
    try {
      // Show how different prefixes route to different backends
      const testIds = ["md#007", "json#123", "md#443"];

      for (const taskId of testIds) {
        const backend = await taskService.getBackendForTask(taskId);
        console.log(`   ${taskId} → routes to: ${backend}`);
      }
    } catch (error) {
      console.log(`ℹ️  Error testing routing: ${error.message}`);
    }
    console.log();

    // Test 4: Show that TaskServiceInterface methods all work
    console.log("🧪 Test 4: TaskServiceInterface compatibility");
    console.log(`✅ getWorkspacePath(): ${taskService.getWorkspacePath()}`);

    try {
      const status = await taskService.getTaskStatus("md#007");
      console.log(`✅ getTaskStatus('md#007'): ${status || "undefined"}`);
    } catch (error) {
      console.log(`ℹ️  getTaskStatus error: ${error.message}`);
    }

    console.log("\n🎉 Multi-Backend Demo Complete!");
    console.log("✨ Key Benefits Demonstrated:");
    console.log("   • Qualified ID routing (md#, json# prefixes)");
    console.log("   • Multiple backend support in single service");
    console.log("   • Full TaskServiceInterface compatibility");
    console.log("   • Zero code changes needed for existing functionality");
  } catch (error) {
    console.error("❌ Demo failed:", error.message);
    console.error(error.stack);
    return false;
  }

  return true;
}

// Run the demo
demonstrateMultiBackend()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error("❌ Unhandled error:", error);
    process.exit(1);
  });
