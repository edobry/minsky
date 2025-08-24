#!/usr/bin/env bun
// Demonstrate both MD and MT (Minsky) backends working
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { initializeConfiguration } from "./src/domain/configuration";

async function demonstrateBothBackends() {
  console.log("🧪 Multi-Backend Demo: MD and MT Tasks\n");

  try {
    // Initialize configuration for database backend
    console.log("⚙️ Initializing configuration for database backend...");
    await initializeConfiguration({
      workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
    });
    console.log("   ✅ Configuration initialized\n");

    // Create the multi-backend service
    const taskService = await createConfiguredTaskService({
      workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
    });

    const backends = (taskService as any).listBackends?.() || [];
    console.log("🔧 Registered backends:");
    backends.forEach((backend: any, index: number) => {
      console.log(`   ${index + 1}. ${backend.name} (prefix: ${backend.prefix})`);
    });
    console.log();

    // Get all tasks and analyze prefixes
    console.log("📊 Task Analysis:");
    const allTasks = await taskService.listTasks();
    console.log(`   Total tasks: ${allTasks.length}`);

    // Count by prefix
    const prefixCounts = new Map<string, number>();
    allTasks.forEach((task) => {
      const match = task.id.match(/^([^#]+)#/);
      const prefix = match ? match[1] : "no-prefix";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    });

    console.log("   By prefix:");
    for (const [prefix, count] of prefixCounts.entries()) {
      console.log(`     ${prefix}#: ${count} tasks`);
    }
    console.log();

    // Test specific task retrieval
    console.log("🧪 Testing qualified ID routing:");

    // Test MD task
    try {
      const mdTask = await taskService.getTask("md#007");
      if (mdTask) {
        console.log(`   ✅ md#007: "${mdTask.title}" [${mdTask.status}]`);
        console.log(`      Routes to: ${await taskService.getBackendForTask("md#007")}`);
      }
    } catch (error) {
      console.log(`   ❌ md#007 error: ${error.message}`);
    }

    // Test MT task (if any exist)
    const mtTasks = allTasks.filter((task) => task.id.startsWith("mt#"));
    if (mtTasks.length > 0) {
      const sampleMtTask = mtTasks[0];
      console.log(`   ✅ ${sampleMtTask.id}: "${sampleMtTask.title}" [${sampleMtTask.status}]`);
      console.log(`      Routes to: ${await taskService.getBackendForTask(sampleMtTask.id)}`);
    } else {
      console.log("   ℹ️  No mt# tasks found in current dataset");
      console.log("   🔍 Testing mt# routing anyway:");
      console.log(`      mt#123 would route to: ${await taskService.getBackendForTask("mt#123")}`);
    }

    console.log("\n🎉 Multi-Backend Demo Complete!");
    console.log(
      `✨ Successfully demonstrated ${backends.length} backends with ${allTasks.length} total tasks`
    );
  } catch (error) {
    console.error("❌ Demo failed:", error.message);
    console.error(error.stack);
  }
}

demonstrateBothBackends().catch(console.error);
