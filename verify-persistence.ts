#!/usr/bin/env bun

/**
 * Verification script for PersistenceProvider architecture
 * Tests that all the core functionality works correctly
 */

import { PersistenceService } from "./src/domain/persistence/service";
import { CustomConfigFactory, initializeConfiguration } from "./src/domain/configuration";
import { getMinskyStateDir } from "./src/utils/paths";
import path from "path";

async function main() {
  console.log("🔍 Verifying PersistenceProvider Architecture\n");

  // Initialize configuration with persistence support
  await initializeConfiguration(
    new CustomConfigFactory(),
    path.join(getMinskyStateDir(), "config.toml")
  );

  console.log("✅ Configuration initialized");

  // Initialize PersistenceService
  await PersistenceService.initialize();
  console.log("✅ PersistenceService initialized");

  // Get the provider
  const provider = PersistenceService.getProvider();
  console.log(`✅ Active provider: ${provider.constructor.name}`);

  // Test capabilities
  const capabilities = provider.getCapabilities();
  console.log("✅ Provider capabilities:", {
    sql: capabilities.sql,
    transactions: capabilities.transactions,
    vectorStorage: capabilities.vectorStorage,
    jsonb: capabilities.jsonb,
    migrations: capabilities.migrations,
  });

  // Test database connection
  try {
    const db = await provider.getDatabaseConnection();
    if (db) {
      console.log("✅ Database connection established");
    } else {
      console.log("⚠️  No database connection (provider doesn't support SQL)");
    }
  } catch (error) {
    console.log("⚠️  Database connection failed:", error);
  }

  // Test vector storage if supported
  if (capabilities.vectorStorage) {
    try {
      const vectorStorage = await provider.getVectorStorage();
      console.log(`✅ Vector storage available: ${vectorStorage.constructor.name}`);
    } catch (error) {
      console.log("⚠️  Vector storage failed:", error);
    }
  } else {
    console.log("ℹ️  Vector storage not supported by this provider");
  }

  // Test storage interface
  try {
    const storage = await provider.getStorage();
    console.log(`✅ Storage interface available: ${storage.constructor.name}`);
  } catch (error) {
    console.log("⚠️  Storage interface failed:", error);
  }

  console.log("\n🎉 PersistenceProvider architecture verification complete");

  // Cleanup
  await PersistenceService.close();
  console.log("✅ Resources cleaned up");
}

main().catch(console.error);
