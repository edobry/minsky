#!/usr/bin/env bun

/**
 * Test script for sessiondb migration functionality
 * Tests the migration without CLI dependencies
 */

import { registerSessiondbCommands } from "../src/adapters/shared/commands/sessiondb";
import { sharedCommandRegistry } from "../src/adapters/shared/command-registry";
import { log } from "../src/utils/logger";

async function testSessiondbMigration() {
  log.info("Testing sessiondb migration functionality...");

  // Register the commands
  registerSessiondbCommands();

  // Get the migrate command
  const migrateCommand = sharedCommandRegistry.getCommand("sessiondb.migrate");
  
  if (!migrateCommand) {
    throw new Error("sessiondb.migrate command not found");
  }

  log.info("✅ sessiondb.migrate command registered successfully");

  // Test dry run migration from backup
  const backupFile = "/Users/edobry/.local/state/minsky/session-db-backup-1750696515391.json";
  
  try {
    const result = await migrateCommand.execute(
      {
        to: "sqlite",
        from: backupFile,
        dryRun: true,
      },
      {
        interface: "test",
        debug: true,
      }
    );

    log.info("✅ Dry run migration test successful:", result);
    
    if (result.success) {
      log.info(`Would migrate ${result.sourceCount} sessions from backup to SQLite`);
    }

    return result;
  } catch (error) {
    log.error("❌ Migration test failed:", error);
    throw error;
  }
}

// Run the test
testSessiondbMigration()
  .then((result) => {
    log.info("🎉 All tests passed!");
    process.exit(0);
  })
  .catch((error) => {
    log.error("💥 Test failed:", error);
    process.exit(1);
  }); 
