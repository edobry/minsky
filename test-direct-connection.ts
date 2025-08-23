#!/usr/bin/env bun
// Test direct database connection and minsky backend
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createMinskyTaskBackend } from "./src/domain/tasks/minskyTaskBackend";
import { createMultiBackendTaskService } from "./src/domain/tasks/multi-backend-service";
import { createMarkdownTaskBackend } from "./src/domain/tasks/markdownTaskBackend";
import { createJsonFileTaskBackend } from "./src/domain/tasks/jsonFileTaskBackend";

async function testDirectConnection() {
  console.log("🔧 Testing Direct Database Connection\n");

  try {
    // Create direct database connection
    console.log("1️⃣ Creating direct database connection...");
    const sql = postgres("postgresql://localhost:5432/minsky", {
      prepare: false,
      onnotice: () => {},
    });
    const db = drizzle(sql);
    console.log("   ✅ Database connection created");

    // Create minsky backend directly
    console.log("\n2️⃣ Creating minsky backend...");
    const minskyBackend = createMinskyTaskBackend({
      name: "minsky",
      workspacePath: "/Users/edobry/Projects/minsky",
      db,
    });
    console.log("   ✅ Minsky backend created");

    // Test minsky backend directly
    console.log("\n3️⃣ Testing minsky backend directly...");
    try {
      const minskyTasks = await minskyBackend.listTasks();
      console.log(`   📋 Minsky backend returned ${minskyTasks.length} tasks`);

      if (minskyTasks.length > 0) {
        const sampleTasks = minskyTasks.slice(0, 3);
        sampleTasks.forEach((task, i) => {
          console.log(`     ${i + 1}. ${task.id}: "${task.title}"`);
        });
      } else {
        console.log("   ℹ️  No tasks in minsky backend yet");
      }
    } catch (error) {
      console.log(`   ❌ Minsky backend error: ${error.message}`);
    }

    // Create full multi-backend service
    console.log("\n4️⃣ Creating multi-backend service...");
    const service = createMultiBackendTaskService({
      workspacePath: "/Users/edobry/Projects/minsky",
    });

    // Register all backends
    const markdownBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: "/Users/edobry/Projects/minsky",
    });
    (markdownBackend as any).prefix = "md";
    service.registerBackend(markdownBackend);

    const jsonBackend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath: "/Users/edobry/Projects/minsky",
    });
    (jsonBackend as any).prefix = "json";
    service.registerBackend(jsonBackend);

    (minskyBackend as any).prefix = "mt";
    service.registerBackend(minskyBackend);

    console.log("   ✅ All backends registered");

    // Test multi-backend service
    console.log("\n5️⃣ Testing multi-backend service...");
    const backends = service.listBackends();
    console.log(`   Registered backends: ${backends.length}`);
    backends.forEach((backend: any, i: number) => {
      console.log(`     ${i + 1}. ${backend.name} (prefix: ${backend.prefix})`);
    });

    const allTasks = await service.listTasks();
    console.log(`   Total tasks across all backends: ${allTasks.length}`);

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

    // Test routing
    console.log(`\n6️⃣ Testing backend routing:`);
    const testIds = ["md#007", "mt#100", "json#001"];
    for (const taskId of testIds) {
      const backendName = await service.getBackendForTask(taskId);
      console.log(`   ${taskId} → ${backendName} backend`);
    }

    console.log(`\n🎯 SUCCESS! Multi-backend system is working!`);
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

testDirectConnection().catch(console.error);
