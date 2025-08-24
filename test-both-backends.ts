#!/usr/bin/env bun
// Test both MD and MT backends from main workspace
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function testBothBackends() {
  console.log("🧪 Testing Both MD and MT Backends from Main Workspace\n");

  try {
    const taskService = await createConfiguredTaskService({
      workspacePath: "/Users/edobry/Projects/minsky",
    });

    const backends = (taskService as any).listBackends?.() || [];
    console.log("🔧 Registered backends:");
    backends.forEach((backend: any, index: number) => {
      console.log(`   ${index + 1}. ${backend.name} (prefix: ${backend.prefix})`);
    });
    console.log();

    // Get all tasks and check prefixes
    const allTasks = await taskService.listTasks();
    console.log(`📊 Total tasks: ${allTasks.length}`);

    // Count by prefix
    const prefixCounts = new Map<string, number>();
    const samplesByPrefix = new Map<string, string[]>();

    allTasks.forEach((task) => {
      const match = task.id.match(/^([^#]+)#/);
      const prefix = match ? match[1] : "no-prefix";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);

      if (!samplesByPrefix.has(prefix)) {
        samplesByPrefix.set(prefix, []);
      }
      if (samplesByPrefix.get(prefix)!.length < 2) {
        samplesByPrefix.get(prefix)!.push(`${task.id}: "${task.title}"`);
      }
    });

    console.log("\nTask distribution by prefix:");
    for (const [prefix, count] of prefixCounts.entries()) {
      console.log(`   ${prefix}#: ${count} tasks`);
      const samples = samplesByPrefix.get(prefix) || [];
      samples.forEach((sample) => {
        console.log(`     • ${sample}`);
      });
    }

    console.log("\n🧪 Testing specific task routing:");

    // Test MD task
    try {
      const mdTask = await taskService.getTask("md#007");
      if (mdTask) {
        console.log(`✅ md#007 → "${mdTask.title}" [${mdTask.status}]`);
      } else {
        console.log("❌ md#007 not found");
      }
    } catch (error) {
      console.log(`❌ md#007 error: ${error.message}`);
    }

    // Test MT task (try a few IDs)
    const mtTestIds = ["mt#001", "mt#100", "mt#200"];
    for (const testId of mtTestIds) {
      try {
        const mtTask = await taskService.getTask(testId);
        if (mtTask) {
          console.log(`✅ ${testId} → "${mtTask.title}" [${mtTask.status}]`);
          break;
        }
      } catch (error) {
        console.log(`❌ ${testId} error: ${error.message}`);
      }
    }
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

testBothBackends().catch(console.error);
