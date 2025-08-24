#!/usr/bin/env bun
// Debug Minsky Backend Registration
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import { createMinskyTaskBackend } from "./src/domain/tasks/minskyTaskBackend";

async function debugMinskyBackend() {
  console.log("🔍 Debugging Minsky Backend Registration\n");

  // Test 1: Try to create database connection directly
  console.log("1️⃣ Testing database connection...");
  try {
    const db = await createDatabaseConnection();
    console.log("   ✅ Database connection successful");

    // Test 2: Try to create minsky backend directly
    console.log("\n2️⃣ Testing minsky backend creation...");
    try {
      const minskyBackend = createMinskyTaskBackend({
        name: "minsky",
        workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
        db,
      });
      console.log("   ✅ Minsky backend created successfully");

      // Test 3: Try to list tasks from minsky backend
      console.log("\n3️⃣ Testing minsky backend task listing...");
      try {
        const tasks = await minskyBackend.listTasks();
        console.log(`   ✅ Minsky backend returned ${tasks.length} tasks`);

        // Show sample tasks with mt# prefixes
        const sampleTasks = tasks.slice(0, 3);
        sampleTasks.forEach((task, index) => {
          console.log(`      ${index + 1}. ${task.id}: "${task.title}" [${task.status}]`);
        });
      } catch (taskError) {
        console.log(`   ❌ Error listing minsky tasks: ${taskError.message}`);
      }
    } catch (backendError) {
      console.log(`   ❌ Error creating minsky backend: ${backendError.message}`);
    }
  } catch (dbError) {
    console.log(`   ❌ Database connection failed: ${dbError.message}`);
    console.log("   ℹ️  This explains why minsky backend isn't registered");
  }

  console.log("\n4️⃣ Testing multi-backend service...");
  try {
    const taskService = await createConfiguredTaskService({
      workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
    });

    const backends = (taskService as any).listBackends?.() || [];
    console.log(`   📊 Registered backends: ${backends.length}`);
    backends.forEach((backend: any) => {
      console.log(`      - ${backend.name} (prefix: ${backend.prefix})`);
    });

    const allTasks = await taskService.listTasks();
    console.log(`   📋 Total tasks across all backends: ${allTasks.length}`);

    // Check for different prefixes
    const prefixes = new Set(
      allTasks.map((task) => {
        const match = task.id.match(/^([^#]+)#/);
        return match ? match[1] : "no-prefix";
      })
    );

    console.log(`   🏷️  Found prefixes: ${Array.from(prefixes).join(", ")}`);
  } catch (error) {
    console.log(`   ❌ Multi-backend service error: ${error.message}`);
  }

  console.log("\n🔬 Diagnosis Complete!");
}

debugMinskyBackend().catch(console.error);
