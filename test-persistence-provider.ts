#!/usr/bin/env bun

/**
 * Test script to demonstrate PersistenceProvider implementation
 * Following testing-session-repo-changes guidelines
 */

import { PersistenceProviderFactory } from "./src/domain/persistence/factory";
import { PersistenceService } from "./src/domain/persistence/service";
import type { PersistenceConfig } from "./src/domain/persistence/types";

async function testPersistenceProviders() {
  console.log("=== Testing PersistenceProvider Implementation ===\n");

  // Test 1: Create PostgreSQL Provider
  console.log("1. Testing PostgreSQL Provider:");
  const postgresConfig: PersistenceConfig = {
    backend: "postgres",
    postgres: {
      connectionString: "postgresql://localhost:5432/testdb",
      maxConnections: 10
    }
  };
  
  try {
    const postgresProvider = PersistenceProviderFactory.create(postgresConfig);
    console.log("   ✅ PostgreSQL provider created");
    console.log("   Capabilities:", postgresProvider.capabilities);
    console.log("   Connection info:", postgresProvider.getConnectionInfo());
  } catch (error) {
    console.log("   ❌ Failed to create PostgreSQL provider:", error);
  }

  // Test 2: Create SQLite Provider
  console.log("\n2. Testing SQLite Provider:");
  const sqliteConfig: PersistenceConfig = {
    backend: "sqlite",
    sqlite: {
      dbPath: "./test.db"
    }
  };
  
  try {
    const sqliteProvider = PersistenceProviderFactory.create(sqliteConfig);
    console.log("   ✅ SQLite provider created");
    console.log("   Capabilities:", sqliteProvider.capabilities);
    console.log("   Connection info:", sqliteProvider.getConnectionInfo());
  } catch (error) {
    console.log("   ❌ Failed to create SQLite provider:", error);
  }

  // Test 3: Create JSON Provider
  console.log("\n3. Testing JSON Provider:");
  const jsonConfig: PersistenceConfig = {
    backend: "json",
    json: {
      filePath: "./data.json"
    }
  };
  
  try {
    const jsonProvider = PersistenceProviderFactory.create(jsonConfig);
    console.log("   ✅ JSON provider created");
    console.log("   Capabilities:", jsonProvider.capabilities);
    console.log("   Connection info:", jsonProvider.getConnectionInfo());
  } catch (error) {
    console.log("   ❌ Failed to create JSON provider:", error);
  }

  // Test 4: Test PersistenceService singleton
  console.log("\n4. Testing PersistenceService Singleton:");
  try {
    await PersistenceService.initialize(postgresConfig);
    console.log("   ✅ PersistenceService initialized");
    
    const provider = PersistenceService.getProvider();
    console.log("   ✅ Got provider from service");
    console.log("   Provider type:", provider.constructor.name);
    
    // Test vector storage capability check
    if (provider.capabilities.vectorStorage) {
      console.log("   ✅ Provider supports vector storage");
      // Note: Actual vector storage creation would require a real DB connection
    } else {
      console.log("   ℹ️ Provider does not support vector storage");
    }
    
    await PersistenceService.close();
    console.log("   ✅ PersistenceService closed");
  } catch (error) {
    console.log("   ❌ PersistenceService test failed:", error);
  }

  // Test 5: Test capability checking
  console.log("\n5. Testing Capability Checking:");
  const providers = [
    { name: "PostgreSQL", config: postgresConfig },
    { name: "SQLite", config: sqliteConfig },
    { name: "JSON", config: jsonConfig }
  ];
  
  for (const { name, config } of providers) {
    const provider = PersistenceProviderFactory.create(config);
    console.log(`\n   ${name} capabilities:`);
    console.log(`   - SQL: ${provider.capabilities.sql}`);
    console.log(`   - Transactions: ${provider.capabilities.transactions}`);
    console.log(`   - JSONB: ${provider.capabilities.jsonb}`);
    console.log(`   - Vector Storage: ${provider.capabilities.vectorStorage}`);
    console.log(`   - Migrations: ${provider.capabilities.migrations}`);
  }

  console.log("\n=== PersistenceProvider Testing Complete ===");
}

// Run the tests
testPersistenceProviders().catch(console.error);
