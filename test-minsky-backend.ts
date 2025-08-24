#!/usr/bin/env bun
// Test if the minsky backend now works with database
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { initializeConfiguration } from "./src/domain/configuration";

async function testMinskyBackend() {
  console.log("🔧 Testing Minsky Backend with Database\n");

  try {
    // Initialize configuration
    console.log("1️⃣ Initializing configuration...");
    await initializeConfiguration({ workspacePath: "/Users/edobry/Projects/minsky" });
    console.log("   ✅ Configuration initialized");

    // Create task service
    console.log("\n2️⃣ Creating configured task service...");
    const taskService = await createConfiguredTaskService({
      workspacePath: "/Users/edobry/Projects/minsky",
    });
    console.log("   ✅ Task service created");

    // Check registered backends
    const backends = (taskService as any).listBackends?.() || [];
    console.log(`\n3️⃣ Registered backends: ${backends.length}`);
    backends.forEach((backend: any, i: number) => {
      console.log(`   ${i + 1}. ${backend.name} (prefix: ${backend.prefix})`);
    });

    // List all tasks
    console.log(`\n4️⃣ Listing all tasks...`);
    const allTasks = await taskService.listTasks();
    console.log(`   Total tasks: ${allTasks.length}`);

    // Count by prefix
    const prefixCounts = new Map<string, number>();
    allTasks.forEach((task) => {
      const match = task.id.match(/^([^#]+)#/);
      const prefix = match ? match[1] : "no-prefix";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    });

    console.log(`   Task distribution:`);
    for (const [prefix, count] of prefixCounts.entries()) {
      console.log(`     ${prefix}#: ${count} tasks`);
    }

    // Test specific task retrieval
    console.log(`\n5️⃣ Testing qualified ID routing:`);

    // Test MD task
    try {
      const mdTask = await taskService.getTask("md#007");
      if (mdTask) {
        console.log(`   ✅ md#007 found: "${mdTask.title}"`);
        console.log(`      Routes to: ${await taskService.getBackendForTask("md#007")}`);
      } else {
        console.log(`   ❌ md#007 not found`);
      }
    } catch (error) {
      console.log(`   💥 md#007 error: ${error.message}`);
    }

    // Test MT task
    try {
      const mtTask = await taskService.getTask("mt#100");
      if (mtTask) {
        console.log(`   ✅ mt#100 found: "${mtTask.title}"`);
        console.log(`      Routes to: ${await taskService.getBackendForTask("mt#100")}`);
        console.log(`      Task ID: ${mtTask.id} (should be mt#100, not md#100)`);
      } else {
        console.log(`   ❌ mt#100 not found`);
      }
    } catch (error) {
      console.log(`   💥 mt#100 error: ${error.message}`);
    }

    console.log(`\n🎯 RESULTS:`);
    if (prefixCounts.has("mt") && prefixCounts.get("mt")! > 0) {
      console.log(`   ✅ SUCCESS: Found ${prefixCounts.get("mt")} mt# tasks!`);
      console.log(`   ✅ Multi-backend routing is working correctly`);
    } else {
      console.log(`   ⚠️  No mt# tasks found - may need to populate database`);
    }
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

testMinskyBackend().catch(console.error);
