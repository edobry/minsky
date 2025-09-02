#!/usr/bin/env bun
/**
 * Verify FK constraints and test task dependencies
 */

import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";

async function verifyFKAndDeps() {
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

    // Check if FK constraints exist
    console.log('🔍 Checking FK constraints...');
    const constraints = await sql`
      SELECT 
        conname as constraint_name,
        confrelid::regclass as foreign_table,
        conrelid::regclass as table_name
      FROM pg_constraint 
      WHERE contype = 'f' 
      AND conrelid = 'task_relationships'::regclass;
    `;
    
    console.log('📋 FK Constraints found:', constraints.length);
    for (const c of constraints) {
      console.log(`  - ${c.constraint_name}: ${c.table_name} → ${c.foreign_table}`);
    }

    // Test TaskGraphService
    console.log('\n🔗 Testing TaskGraphService...');
    const graphService = new TaskGraphService(db);
    
    // List some existing dependencies  
    const testTasks = ['mt#237', 'mt#239', 'mt#468'];
    for (const taskId of testTasks) {
      try {
        const deps = await graphService.listDependencies(taskId);
        console.log(`  ${taskId} depends on: [${deps.join(', ')}]`);
      } catch (error) {
        console.log(`  ${taskId}: Error - ${error.message}`);
      }
    }

    // Close database connection
    await sql.end();
    console.log('\n✅ Verification complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Verification failed:', error.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  verifyFKAndDeps();
}
