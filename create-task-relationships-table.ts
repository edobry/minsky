#!/usr/bin/env bun
/**
 * Manually create the task_relationships table
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";

async function createTaskRelationshipsTable() {
  try {
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true
    });

    const db = await createDatabaseConnection();
    const sql = (db as any)._.session.client;

    console.log('🔧 Creating task_relationships table...');

    // Create the table and indexes from migration 0014
    await sql`
      CREATE TABLE "task_relationships" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "from_task_id" text NOT NULL,
        "to_task_id" text NOT NULL
      );
    `;

    await sql`
      CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" 
      USING btree ("from_task_id","to_task_id");
    `;

    await sql`
      CREATE INDEX "tr_from_idx" ON "task_relationships" 
      USING btree ("from_task_id");
    `;

    await sql`
      CREATE INDEX "tr_to_idx" ON "task_relationships" 
      USING btree ("to_task_id");
    `;

    console.log('✅ task_relationships table created successfully!');

    // Test the table
    const testResult = await sql`SELECT COUNT(*) as count FROM task_relationships;`;
    console.log(`📊 Table accessible, current rows: ${testResult[0].count}`);

  } catch (error) {
    console.error('❌ Failed to create table:', error.message);
    
    // If table already exists, that's okay
    if (error.message.includes('already exists')) {
      console.log('ℹ️  Table already exists, continuing...');
    } else {
      throw error;
    }
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) {
  createTaskRelationshipsTable();
}
