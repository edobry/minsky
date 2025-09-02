#!/usr/bin/env bun
/**
 * Check what tables actually exist in the database
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";

async function checkDatabaseTables() {
  try {
    // Initialize configuration
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true
    });

    const db = await createDatabaseConnection();

    // Get the underlying postgres-js instance
    const sql = (db as any)._.session.client;
    
    // Check what tables exist
    console.log('📋 Checking database tables...');
    const tablesResult = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `;
    
    console.log('🔍 Tables in database:');
    for (const row of tablesResult) {
      console.log(`  - ${row.table_name}`);
    }
    
    // Check migration state
    console.log('\n📋 Checking migration state...');
    try {
      const migrationsResult = await sql`
        SELECT * FROM drizzle_migrations 
        ORDER BY created_at DESC 
        LIMIT 5;
      `;
      
      console.log('🔍 Recent migrations:');
      for (const row of migrationsResult) {
        console.log(`  - ${row.hash} at ${row.created_at}`);
      }
    } catch (migrationError) {
      console.log('❌ Could not check migrations table:', migrationError.message);
    }

    // If task_relationships is missing, show the SQL to create it
    const hasTaskRelationships = tablesResult.some(row => row.table_name === 'task_relationships');
    if (!hasTaskRelationships) {
      console.log('\n🔧 task_relationships table is missing. SQL to create it:');
      console.log(`
CREATE TABLE "task_relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_task_id" text NOT NULL,
  "to_task_id" text NOT NULL
);

CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" USING btree ("from_task_id","to_task_id");
CREATE INDEX "tr_from_idx" ON "task_relationships" USING btree ("from_task_id");
CREATE INDEX "tr_to_idx" ON "task_relationships" USING btree ("to_task_id");
      `);
      
      console.log('\n💡 Run this SQL manually or regenerate migrations');
    }

  } catch (error) {
    console.error('❌ Database check failed:', error.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) {
  checkDatabaseTables();
}
