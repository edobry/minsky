#!/usr/bin/env bun

/**
 * Demo script to test task database synchronization
 */

import { syncTaskDatabases } from "./task-database-sync";
import { log } from "./logger";

async function main() {
  console.log("🔄 Testing Task Database Synchronization...\n");

  try {
    // First, do a dry run to see what would happen
    console.log("📋 Dry run to analyze sync requirements:");
    const dryResult = await syncTaskDatabases({
      direction: "bidirectional",
      dryRun: true,
    });

    console.log("Dry run result:", JSON.stringify(dryResult, null, 2));

    if (dryResult.success && dryResult.action !== "no-sync-needed") {
      console.log("\n🚀 Performing actual synchronization:");

      const syncResult = await syncTaskDatabases({
        direction: "bidirectional",
        dryRun: false,
      });

      console.log("Sync result:", JSON.stringify(syncResult, null, 2));

      if (syncResult.success) {
        console.log("\n✅ Synchronization completed successfully!");
        console.log(`Direction: ${syncResult.syncDirection}`);
        console.log(`Content size: ${syncResult.contentLength} bytes`);
      } else {
        console.log("\n❌ Synchronization failed:");
        console.log(`Error: ${syncResult.error}`);
      }
    } else {
      console.log("\n✅ No synchronization needed - databases already in sync");
    }
  } catch (error) {
    console.error("\n💥 Sync test failed:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
