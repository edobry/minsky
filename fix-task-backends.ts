#!/usr/bin/env bun
/**
 * Fix backend field for migrated tasks
 * Update tasks from backend="markdown" to backend="db"
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { tasksTable } from "./src/domain/storage/schemas/task-embeddings";
import { getConfiguration } from "./src/domain/configuration";

async function main() {
  console.log("🔧 Fixing task backend fields...");

  // Get database connection
  const config = getConfiguration();
  const connectionString = config?.sessiondb?.postgres?.connectionString;

  if (!connectionString) {
    throw new Error("PostgreSQL connection string not configured");
  }

  const sql = postgres(connectionString, { prepare: false, onnotice: () => {} });
  const db = drizzle(sql);

  // Count tasks with backend="markdown"
  const markdownTasks = await db.select().from(tasksTable).where(eq(tasksTable.backend, "markdown"));
  console.log(`📝 Found ${markdownTasks.length} tasks with backend="markdown"`);

  if (markdownTasks.length === 0) {
    console.log("✅ No tasks need updating");
    await sql.end();
    return;
  }

  console.log("🔄 Updating backend field from 'markdown' to 'db'...");

  // Update all tasks with backend="markdown" to backend="db"
  await db
    .update(tasksTable)
    .set({
      backend: "db" as any,
      updatedAt: new Date()
    })
    .where(eq(tasksTable.backend, "markdown"));

  // Verify the update
  const dbTasks = await db.select().from(tasksTable).where(eq(tasksTable.backend, "db"));
  console.log(`✅ Updated ${dbTasks.length} tasks to backend="db"`);

  await sql.end();
  console.log("🎉 Backend fix complete!");
}

main().catch(console.error);
