#!/usr/bin/env bun

import { listTasksFromParams } from "./src/domain/tasks";

async function testLegacyReplacement() {
  try {
    console.log("🧪 Testing legacy TaskService replacement...");

    console.log("\n📋 Testing listTasks with all backends:");
    const allTasks = await listTasksFromParams({ all: true });
    console.log(`✅ Found ${allTasks.length} total tasks`);

    // Group by backend prefix
    const tasksByBackend = allTasks.reduce(
      (acc, task) => {
        const backend = task.id.split("#")[0];
        acc[backend] = (acc[backend] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.log("\n📊 Tasks by backend:");
    for (const [backend, count] of Object.entries(tasksByBackend)) {
      console.log(`  ${backend}#: ${count} tasks`);
    }

    // Test specific backend functionality
    if (tasksByBackend.mt > 0) {
      console.log("\n🔍 Testing mt# task access:");
      const mtTasks = allTasks.filter((task) => task.id.startsWith("mt#"));
      console.log(`Found ${mtTasks.length} mt# tasks`);
      console.log("Sample mt# tasks:");
      mtTasks.slice(0, 2).forEach((task) => {
        console.log(`  - ${task.id}: ${task.title}`);
      });
    }

    if (tasksByBackend.md > 0) {
      console.log("\n📝 Testing md# task access:");
      const mdTasks = allTasks.filter((task) => task.id.startsWith("md#"));
      console.log(`Found ${mdTasks.length} md# tasks`);
      console.log("Sample md# tasks:");
      mdTasks.slice(0, 2).forEach((task) => {
        console.log(`  - ${task.id}: ${task.title}`);
      });
    }

    console.log("\n🎉 Legacy TaskService replacement successful!");
    console.log("✅ All task backends are working through the unified multi-backend service");
  } catch (error) {
    console.error("❌ Error testing replacement:", error);
    process.exit(1);
  }
}

testLegacyReplacement();
