#!/usr/bin/env bun

/**
 * Demo script to test task database synchronization
 */

import { syncTaskDatabases } from "./task-database-sync";
import { log } from "./logger";

async function main() {
  log.debug("🔄 Testing Task Database Synchronization...\n");

  try {
    // First, do a dry run to see what would happen
    log.debug("📋 Dry run to analyze sync requirements:");
    const dryResult = await syncTaskDatabases({
      direction: "bidirectional",
      dryRun: true,
    });

    log.debug("Dry run result:", JSON.stringify(dryResult, null, 2));

    if (dryResult.success && dryResult.action !== "no-sync-needed") {
      log.debug("\n🚀 Performing actual synchronization:");

      const syncResult = await syncTaskDatabases({
        direction: "bidirectional",
        dryRun: false,
      });

      log.debug("Sync result:", JSON.stringify(syncResult, null, 2));

      if (syncResult.success) {
        log.debug("\n✅ Synchronization completed successfully!");
        log.debug(`Direction: ${syncResult.syncDirection}`);
        log.debug(`Content size: ${syncResult.contentLength} bytes`);
      } else {
        log.debug("\n❌ Synchronization failed:");
        log.debug(`Error: ${syncResult.error}`);
      }
    } else {
      log.debug("\n✅ No synchronization needed - databases already in sync");
    }
  } catch (error) {
    log.error("\n💥 Sync test failed:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
