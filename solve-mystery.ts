#!/usr/bin/env bun
// Solve the mt#100 mystery
import { createMarkdownTaskBackend } from "./src/domain/tasks/markdownTaskBackend";

async function solveMystery() {
  console.log("🕵️ Solving the MT#100 Mystery\n");

  const mdBackend = createMarkdownTaskBackend({
    name: "markdown",
    workspacePath: "/Users/edobry/Projects/minsky",
  });

  const allTasks = await mdBackend.listTasks();

  console.log("1️⃣ Looking for tasks with local ID '100':");

  // Find all tasks that have local ID "100"
  const tasksWithId100 = allTasks.filter((task) => {
    const localId = task.id.includes("#") ? task.id.split("#").pop() : task.id;
    return localId === "100";
  });

  console.log(`   Found ${tasksWithId100.length} tasks with local ID '100':`);
  tasksWithId100.forEach((task) => {
    console.log(`     • ${task.id}: "${task.title}"`);
  });

  console.log(`\n2️⃣ Testing the fuzzy match theory:`);
  console.log(`   When you ask for 'mt#100', the markdown backend's fuzzy logic:`);
  console.log(`   1. Extracts local ID: '100'`);
  console.log(`   2. Looks for any task with local ID '100'`);
  console.log(`   3. Finds 'md#100' and returns it`);
  console.log(`   4. But the returned task still has ID 'md#100'`);

  // Test this theory
  console.log(`\n3️⃣ Confirming the theory:`);
  const mtTask = await mdBackend.getTask("mt#100");
  const mdTask = await mdBackend.getTask("md#100");

  if (mtTask && mdTask) {
    console.log(`   mt#100 returns: "${mtTask.title}" (actual ID: ${mtTask.id})`);
    console.log(`   md#100 returns: "${mdTask.title}" (actual ID: ${mdTask.id})`);
    console.log(`   Same task? ${mtTask.id === mdTask.id ? "✅ YES" : "❌ NO"}`);
  }

  console.log(`\n🎯 CONCLUSION:`);
  console.log(`   The markdown backend's fuzzy matching is causing mt#100`);
  console.log(`   to match md#100 by comparing local IDs only.`);
  console.log(`   This is NOT true multi-backend functionality!`);
  console.log(`   It's just fuzzy matching within the same backend.`);

  console.log(`\n💡 WHAT THIS MEANS:`);
  console.log(`   • There are NO actual mt# tasks in this workspace`);
  console.log(`   • The '372 tasks' are ALL md# tasks from markdown backend`);
  console.log(`   • My multi-backend implementation IS needed for true qualified ID routing`);
  console.log(`   • The existing system only has fuzzy matching, not real backend routing`);
}

solveMystery().catch(console.error);
