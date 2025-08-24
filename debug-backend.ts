#!/usr/bin/env bun
// Debug how the markdown backend is finding mt# tasks
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { createMarkdownTaskBackend } from "./src/domain/tasks/markdownTaskBackend";

async function debugBackend() {
  console.log("🔍 Debugging How Markdown Backend Finds MT# Tasks\n");

  // Test 1: Create markdown backend directly
  console.log("1️⃣ Testing markdown backend directly:");
  const mdBackend = createMarkdownTaskBackend({
    name: "markdown",
    workspacePath: "/Users/edobry/Projects/minsky",
  });

  try {
    const mtTask = await mdBackend.getTask("mt#100");
    if (mtTask) {
      console.log(`   ✅ Direct markdown backend found mt#100: "${mtTask.title}"`);
    } else {
      console.log(`   ❌ Direct markdown backend did not find mt#100`);
    }
  } catch (error) {
    console.log(`   💥 Direct markdown backend error: ${error.message}`);
  }

  // Test 2: Check what tasks the markdown backend actually returns
  console.log(`\n2️⃣ What tasks does markdown backend list?`);
  try {
    const allTasks = await mdBackend.listTasks();
    console.log(`   Total tasks from markdown backend: ${allTasks.length}`);

    // Check prefixes
    const prefixes = new Map<string, number>();
    allTasks.forEach((task) => {
      const match = task.id.match(/^([^#]+)#/);
      const prefix = match ? match[1] : "no-prefix";
      prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
    });

    for (const [prefix, count] of prefixes) {
      console.log(`     ${prefix}#: ${count} tasks`);
    }

    // Show first few mt# tasks if any exist
    const mtTasks = allTasks.filter((task) => task.id.startsWith("mt#")).slice(0, 3);
    if (mtTasks.length > 0) {
      console.log(`   First few mt# tasks:`);
      mtTasks.forEach((task) => {
        console.log(`     • ${task.id}: "${task.title}"`);
      });
    }
  } catch (error) {
    console.log(`   💥 Error listing tasks: ${error.message}`);
  }

  // Test 3: Check if there are any database files
  console.log(`\n3️⃣ Looking for database files:`);
  const fs = require("fs");
  const path = require("path");

  const possibleDbFiles = [
    "minsky.db",
    "tasks.db",
    "database.db",
    "minsky.sqlite",
    "minsky.sqlite3",
    ".db/minsky.db",
    "data/tasks.db",
  ];

  for (const dbFile of possibleDbFiles) {
    try {
      const fullPath = path.join("/Users/edobry/Projects/minsky", dbFile);
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        console.log(`   ✅ Found: ${dbFile} (${stats.size} bytes)`);
      }
    } catch (error) {
      // Ignore errors
    }
  }

  console.log(`\n🔍 Summary:`);
  console.log(`   The markdown backend somehow has access to mt# tasks`);
  console.log(`   This suggests there may be additional logic or data sources`);
}

debugBackend().catch(console.error);
