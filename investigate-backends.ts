#!/usr/bin/env bun
// Investigate what's actually happening with backends
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function investigateBackends() {
  console.log("🔍 Investigating Backend Behavior\n");

  const taskService = await createConfiguredTaskService({
    workspacePath: "/Users/edobry/Projects/minsky",
  });

  console.log("🧪 Service details:");
  console.log(`   Service type: ${taskService.constructor.name}`);
  console.log(`   Has listBackends: ${typeof (taskService as any).listBackends}`);

  const backends = (taskService as any).listBackends?.() || [];
  console.log(`   Backends count: ${backends.length}`);

  // Test all tasks
  const allTasks = await taskService.listTasks();
  console.log(`\n📊 All tasks: ${allTasks.length}`);

  // Check prefixes in detail
  const prefixMap = new Map<string, number>();
  allTasks.forEach((task) => {
    const match = task.id.match(/^([^#]+)#/);
    const prefix = match ? match[1] : "no-prefix";
    prefixMap.set(prefix, (prefixMap.get(prefix) || 0) + 1);
  });

  console.log("\nPrefix breakdown:");
  for (const [prefix, count] of prefixMap) {
    console.log(`   ${prefix}#: ${count} tasks`);
  }

  // Test specific tasks
  console.log("\n🧪 Testing specific tasks:");

  const testCases = ["md#007", "md#443", "mt#001", "mt#100", "mt#200", "json#001"];

  for (const taskId of testCases) {
    try {
      const task = await taskService.getTask(taskId);
      if (task) {
        const backend = await taskService.getBackendForTask(taskId);
        console.log(`   ✅ ${taskId} → ${backend} → "${task.title.substring(0, 50)}..."`);
      } else {
        const backend = await taskService.getBackendForTask(taskId);
        console.log(`   ❌ ${taskId} → ${backend} → not found`);
      }
    } catch (error) {
      console.log(`   💥 ${taskId} → error: ${error.message}`);
    }
  }

  // Try to understand what backend is actually being used
  console.log(`\n🔍 Service inspection:`);
  const serviceKeys = Object.keys(taskService);
  console.log(`   Service has keys: ${serviceKeys.slice(0, 5).join(", ")}...`);

  console.log(`   getWorkspacePath(): ${taskService.getWorkspacePath()}`);
}

investigateBackends().catch(console.error);
