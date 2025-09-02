#!/usr/bin/env bun
/**
 * Test dependency creation using MCP tools
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";

async function testDependencyCreation() {
  try {
    // Initialize configuration
    console.log('🔧 Initializing configuration...');
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true
    });

    // Test database connection and table existence
    console.log('🔍 Testing database connection...');
    const db = await createDatabaseConnection();

    // Test raw database query to check if table exists
    console.log('📋 Checking if task_relationships table exists...');
    try {
      // Import the schema to use with drizzle
      const { taskRelationshipsTable } = await import("./src/domain/storage/schemas/task-relationships");
      
      // Try to select from the table (this will fail if table doesn't exist)
      const testQuery = await db.select().from(taskRelationshipsTable).limit(1);
      console.log('✅ task_relationships table exists and is accessible');
    } catch (tableError) {
      console.log('❌ task_relationships table not accessible:', tableError.message);
      throw tableError;
    }

    // Test TaskGraphService directly
    console.log('🧪 Testing TaskGraphService...');
    const graphService = new TaskGraphService(db);
    
    // Try a simple operation
    console.log('➕ Testing add dependency: mt#497 -> mt#237');
    const result = await graphService.addDependency('mt#497', 'mt#237');
    console.log('Result:', result);

    // List dependencies to verify
    console.log('📖 Listing dependencies for mt#497...');
    const deps = await graphService.listDependencies('mt#497');
    console.log('Dependencies:', deps);

    console.log('\n✅ Dependency creation test completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Full error:', error);
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) {
  testDependencyCreation();
}
