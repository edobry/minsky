#!/usr/bin/env bun
/**
 * Apply FK constraints migration directly
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";

async function applyFKMigration() {
  try {
    console.log('🔧 Initializing configuration...');
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true
    });
    
    console.log('🔧 Connecting to database...');
    const db = await createDatabaseConnection();
    const sql = (db as any)._.session.client;

    console.log('📋 Applying FK constraints migration...');
    
    // Apply the FK constraints from migration 0016
    await sql`
      ALTER TABLE "task_relationships" 
      ADD CONSTRAINT "task_relationships_from_task_id_tasks_id_fk" 
      FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") 
      ON DELETE cascade ON UPDATE no action;
    `;
    
    await sql`
      ALTER TABLE "task_relationships" 
      ADD CONSTRAINT "task_relationships_to_task_id_tasks_id_fk" 
      FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") 
      ON DELETE cascade ON UPDATE no action;
    `;

    console.log('✅ FK constraints applied successfully!');

    // Verify constraints were created
    console.log('🔍 Verifying FK constraints...');
    const constraints = await sql`
      SELECT 
        conname as constraint_name,
        confrelid::regclass as foreign_table,
        conrelid::regclass as table_name
      FROM pg_constraint 
      WHERE contype = 'f' 
      AND conrelid = 'task_relationships'::regclass;
    `;
    
    console.log(`📋 FK Constraints applied: ${constraints.length}`);
    for (const c of constraints) {
      console.log(`  ✅ ${c.constraint_name}: ${c.table_name} → ${c.foreign_table}`);
    }

    await sql.end();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  applyFKMigration();
}
