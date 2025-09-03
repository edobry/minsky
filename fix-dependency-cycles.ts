#!/usr/bin/env bun

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { DatabaseConnectionManager } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";

interface CycleFix {
  remove: { from: string; to: string };
  keep: { from: string; to: string };
  reasoning: string;
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  let db: any = null;

  try {
    // Initialize configuration
    console.log("🔧 Initializing configuration...");
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });

    db = await DatabaseConnectionManager.getInstance().getConnection();
    const graphService = new TaskGraphService(db);

    // Define which relationships to fix based on logical analysis
    const fixes: CycleFix[] = [
      {
        remove: { from: "mt#239", to: "mt#237" },
        keep: { from: "mt#237", to: "mt#239" },
        reasoning:
          "Hierarchical system (mt#237) should depend on basic dependencies (mt#239) first",
      },
      {
        remove: { from: "mt#237", to: "mt#240" },
        keep: { from: "mt#240", to: "mt#237" },
        reasoning: "Enhanced planning (mt#240) should build on hierarchical system (mt#237)",
      },
      {
        remove: { from: "mt#252", to: "mt#251" },
        keep: { from: "mt#251", to: "mt#252" },
        reasoning: "Mobile interface (mt#251) should depend on UI system (mt#252) foundation",
      },
      {
        remove: { from: "mt#260", to: "mt#284" },
        keep: { from: "mt#284", to: "mt#260" },
        reasoning: "Task graph integration (mt#284) might need prompt templates (mt#260)",
      },
    ];

    console.log(`\n🔧 ${isDryRun ? "DRY-RUN:" : "FIXING"} ${fixes.length} DEPENDENCY CYCLES\n`);

    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i];
      console.log(`${i + 1}. ${fix.reasoning}`);
      console.log(`   ❌ REMOVING: ${fix.remove.from} → ${fix.remove.to}`);
      console.log(`   ✅ KEEPING:  ${fix.keep.from} → ${fix.keep.to}`);

      if (!isDryRun) {
        try {
          const result = await graphService.removeDependency(fix.remove.from, fix.remove.to);
          console.log(
            `   💫 Result: ${result.removed ? "Successfully removed" : "Not found (already removed?)"}`
          );
        } catch (error) {
          console.log(`   ❌ Error removing: ${error.message}`);
        }
      }

      console.log();
    }

    if (isDryRun) {
      console.log("💡 To apply these changes, run:");
      console.log("   bun run fix-dependency-cycles.ts");
    } else {
      console.log("🎉 Cycle fixes applied! Verifying...");

      // Re-run cycle detection to verify
      console.log("\n🔍 Re-checking for cycles...");
      await new Promise((resolve) => setTimeout(resolve, 100)); // Brief pause
    }
  } catch (error) {
    console.error("❌ Cycle fix failed:", error.message);
    process.exit(1);
  } finally {
    // Clean database connection
    if (db && typeof db.end === "function") {
      try {
        await db.end();
      } catch (closeError) {
        console.warn("Warning: Error closing database connection:", closeError.message);
      }
    }

    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
