#!/usr/bin/env bun
import { setupConfiguration } from "./src/config-setup";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import {
  tasksTable,
  taskSpecsTable,
  tasksEmbeddingsTable,
} from "./src/domain/storage/schemas/task-embeddings";

async function clearDb() {
  await setupConfiguration();
  const db = await createDatabaseConnection();
  await db.delete(tasksEmbeddingsTable);
  await db.delete(taskSpecsTable);
  await db.delete(tasksTable);
  console.log("✅ Database cleared");
}
clearDb().catch(console.error);
