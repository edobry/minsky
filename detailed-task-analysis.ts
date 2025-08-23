#!/usr/bin/env bun
// Detailed analysis of what tasks actually exist
import { createMarkdownTaskBackend } from "./src/domain/tasks/markdownTaskBackend";

async function detailedTaskAnalysis() {
  console.log("🔍 Detailed Task Analysis\n");

  const mdBackend = createMarkdownTaskBackend({
    name: "markdown",
    workspacePath: "/Users/edobry/Projects/minsky",
  });

  // Test 1: Get all tasks and analyze them thoroughly
  console.log("1️⃣ Analyzing all tasks from markdown backend:");
  const allTasks = await mdBackend.listTasks();
  console.log(`   Total tasks: ${allTasks.length}`);

  // Group by actual prefix
  const tasksByPrefix = new Map<string, any[]>();
  const prefixCounts = new Map<string, number>();

  allTasks.forEach((task) => {
    const match = task.id.match(/^([^#]+)#/);
    const prefix = match ? match[1] : "no-prefix";
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);

    if (!tasksByPrefix.has(prefix)) {
      tasksByPrefix.set(prefix, []);
    }
    tasksByPrefix.get(prefix)!.push(task);
  });

  console.log(`   Prefixes found:`);
  for (const [prefix, count] of prefixCounts) {
    console.log(`     ${prefix}#: ${count} tasks`);

    // Show sample tasks for each prefix
    const sampleTasks = tasksByPrefix.get(prefix)!.slice(0, 2);
    sampleTasks.forEach((task) => {
      console.log(`       • ${task.id}: "${task.title.substring(0, 50)}..."`);
    });
  }

  // Test 2: Look for any mt# task in the actual list
  console.log(`\n2️⃣ Searching for mt# tasks in the list:`);
  const mtTasksInList = allTasks.filter((task) => task.id.startsWith("mt#"));
  console.log(`   MT# tasks in list: ${mtTasksInList.length}`);

  if (mtTasksInList.length > 0) {
    mtTasksInList.slice(0, 3).forEach((task) => {
      console.log(`     • ${task.id}: "${task.title}"`);
    });
  }

  // Test 3: Directly test specific mt# tasks
  console.log(`\n3️⃣ Testing specific mt# tasks directly:`);
  const mtTestIds = ["mt#100", "mt#001", "mt#200"];

  for (const testId of mtTestIds) {
    try {
      const task = await mdBackend.getTask(testId);
      if (task) {
        console.log(`     ✅ ${testId}: "${task.title}"`);
        console.log(`        Found via: ${task.id === testId ? "exact match" : "fuzzy match"}`);
      } else {
        console.log(`     ❌ ${testId}: not found`);
      }
    } catch (error) {
      console.log(`     💥 ${testId}: error - ${error.message}`);
    }
  }

  // Test 4: Check if there are multiple backends being used somehow
  console.log(`\n4️⃣ Backend analysis:`);
  console.log(`   Backend name: ${mdBackend.name}`);
  console.log(`   Backend type: ${mdBackend.constructor.name}`);

  console.log(`\n🧐 Mystery to solve:`);
  console.log(`   • listTasks() returns ${allTasks.length} tasks (all md#)`);
  console.log(`   • getTask("mt#100") somehow works`);
  console.log(`   • This suggests special handling in getTask() logic`);
}

detailedTaskAnalysis().catch(console.error);
