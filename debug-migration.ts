#!/usr/bin/env bun

import { setupConfiguration } from "./src/config-setup";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import { tasksTable, taskSpecsTable } from "./src/domain/storage/schemas/task-embeddings";
import { eq } from "drizzle-orm";

async function debugMigration() {
  console.log("🔍 Debugging migration data integrity...");

  await setupConfiguration();
  const db = await createDatabaseConnection();

  // Check tasks table
  const tasks = await db.select().from(tasksTable).limit(5);
  console.log("\n📋 Sample tasks:");
  tasks.forEach((task) => {
    console.log(`  ${task.id}: ${task.title} [${task.status}] (backend: ${task.backend})`);
  });

  // Check task_specs table
  const specs = await db.select().from(taskSpecsTable).limit(3);
  console.log("\n📄 Sample task specs:");
  specs.forEach((spec) => {
    const contentPreview =
      spec.content.length > 100 ? `${spec.content.substring(0, 100)}...` : spec.content;
    console.log(`  ${spec.taskId}: ${contentPreview}`);
  });

  // Check specific task mt#004
  const task004 = await db.select().from(tasksTable).where(eq(tasksTable.id, "mt#004"));
  const spec004 = await db.select().from(taskSpecsTable).where(eq(taskSpecsTable.taskId, "mt#004"));

  console.log("\n🎯 Specific task mt#004:");
  if (task004.length > 0) {
    console.log(`  Task: ${task004[0].title} [${task004[0].status}]`);
  } else {
    console.log("  Task: Not found");
  }

  if (spec004.length > 0) {
    console.log(`  Spec content length: ${spec004[0].content.length} chars`);
    console.log(`  Content preview: ${spec004[0].content.substring(0, 200)}...`);
  } else {
    console.log("  Spec: Not found");
  }
}

debugMigration().catch(console.error);
