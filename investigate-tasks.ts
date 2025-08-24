#!/usr/bin/env bun
// Investigate what tasks and prefixes actually exist
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function investigateTaskPrefixes() {
  console.log("🔍 Investigating Task Prefixes and Backends\n");

  const taskService = await createConfiguredTaskService({
    workspacePath: "/Users/edobry/.local/state/minsky/sessions/task-md#443",
  });

  // Show registered backends
  const backends = (taskService as any).listBackends?.() || [];
  console.log("🔧 Actually Registered Backends:");
  backends.forEach((backend: any, index: number) => {
    console.log(`   ${index + 1}. ${backend.name} (prefix: ${backend.prefix || "none"})`);
  });
  console.log();

  // Get all tasks and analyze their prefixes
  console.log("📋 Analyzing Task Prefixes in Dataset...");
  const allTasks = await taskService.listTasks();
  console.log(`   Total tasks found: ${allTasks.length}`);

  // Count tasks by prefix
  const prefixCounts = new Map<string, number>();
  const samplesByPrefix = new Map<string, string[]>();

  allTasks.forEach((task) => {
    const match = task.id.match(/^([^#]+)#/);
    const prefix = match ? match[1] : "no-prefix";

    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);

    if (!samplesByPrefix.has(prefix)) {
      samplesByPrefix.set(prefix, []);
    }
    if (samplesByPrefix.get(prefix)!.length < 3) {
      samplesByPrefix.get(prefix)!.push(`${task.id}: "${task.title}"`);
    }
  });

  console.log("\n📊 Task Prefix Analysis:");
  for (const [prefix, count] of prefixCounts.entries()) {
    console.log(`   ${prefix}# prefix: ${count} tasks`);
    const samples = samplesByPrefix.get(prefix) || [];
    samples.forEach((sample) => {
      console.log(`      → ${sample}`);
    });
  }

  console.log("\n🤔 Expected vs Actual:");
  console.log("   Expected: md# and mt# (or json#) tasks from different backends");
  console.log("   Actual: Let's see what we found above...");

  // Test specific backend routing
  console.log("\n🧪 Testing Backend Routing for Different Patterns:");
  const testIds = ["md#007", "mt#001", "json#001", "gh#123"];
  for (const taskId of testIds) {
    const backendName = await taskService.getBackendForTask(taskId);
    console.log(`   ${taskId} → ${backendName} backend`);
  }
}

investigateTaskPrefixes().catch(console.error);
