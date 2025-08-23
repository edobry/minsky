#!/usr/bin/env bun
// Check what configuration is being used
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { get } from "./src/domain/configuration/index";

async function checkConfig() {
  console.log("🔍 Checking Configuration and Backend Selection\n");

  try {
    // Check configuration values
    console.log("⚙️ Configuration values:");
    try {
      const backend = get("backend");
      console.log(`   backend: ${backend}`);
    } catch (e) {
      console.log(`   backend: ${e.message}`);
    }

    // Create task service and inspect it
    const taskService = createConfiguredTaskService({
      workspacePath: "/Users/edobry/Projects/minsky",
    });

    console.log(`\n📋 TaskService details:`);
    console.log(`   Type: ${taskService.constructor.name}`);
    console.log(`   Workspace: ${taskService.getWorkspacePath()}`);
    console.log(`   Has backends: ${Array.isArray((taskService as any).backends)}`);

    if ((taskService as any).backends) {
      const backends = (taskService as any).backends;
      console.log(`   Backends count: ${backends.length}`);
      backends.forEach((backend: any, i: number) => {
        console.log(`     ${i + 1}. ${backend.name}`);
      });

      const currentBackend = (taskService as any).currentBackend;
      console.log(`   Current backend: ${currentBackend?.name}`);
    }

    // Test a specific mt# task to see which backend handles it
    console.log(`\n🧪 Testing mt#100 access:`);
    const task = await taskService.getTask("mt#100");
    if (task) {
      console.log(`   ✅ Found: "${task.title}"`);
      console.log(`   Backend: ${await taskService.getBackendForTask("mt#100")}`);
    } else {
      console.log(`   ❌ Not found`);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

checkConfig().catch(console.error);
