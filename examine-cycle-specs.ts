#!/usr/bin/env bun

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function main() {
  try {
    // Initialize configuration
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
    });

    // The cycles we found:
    const cyclePairs = [
      ["mt#237", "mt#239"], // Current task relationships
      ["mt#237", "mt#240"],
      ["mt#251", "mt#252"],
      ["mt#284", "mt#260"],
    ];

    console.log("🔍 Examining task specifications for cycle analysis...\n");

    for (const [taskA, taskB] of cyclePairs) {
      console.log(`\n=== CYCLE: ${taskA} ↔ ${taskB} ===`);

      try {
        const specA = await taskService.getTask(taskA);
        const specB = await taskService.getTask(taskB);

        console.log(`\n📋 ${taskA}: ${specA?.title || "Unknown"}`);
        console.log(`📝 Spec preview: ${(specA?.spec || "").substring(0, 200)}...`);

        console.log(`\n📋 ${taskB}: ${specB?.title || "Unknown"}`);
        console.log(`📝 Spec preview: ${(specB?.spec || "").substring(0, 200)}...`);

        // Look for references to the other task in each spec
        const specALower = (specA?.spec || "").toLowerCase();
        const specBLower = (specB?.spec || "").toLowerCase();

        const aReferencesB =
          specALower.includes(taskB.toLowerCase()) ||
          specALower.includes(taskB.replace("mt#", "").toLowerCase());
        const bReferencesA =
          specBLower.includes(taskA.toLowerCase()) ||
          specBLower.includes(taskA.replace("mt#", "").toLowerCase());

        console.log(`\n🔗 Reference Analysis:`);
        console.log(`   ${taskA} mentions ${taskB}: ${aReferencesB ? "YES" : "NO"}`);
        console.log(`   ${taskB} mentions ${taskA}: ${bReferencesA ? "YES" : "NO"}`);

        // Suggest which relationship to keep based on logical dependency
        if (aReferencesB && !bReferencesA) {
          console.log(`   💡 KEEP: ${taskA} → ${taskB} (A references B)`);
          console.log(`   ❌ REMOVE: ${taskB} → ${taskA} (no reference)`);
        } else if (bReferencesA && !aReferencesB) {
          console.log(`   💡 KEEP: ${taskB} → ${taskA} (B references A)`);
          console.log(`   ❌ REMOVE: ${taskA} → ${taskB} (no reference)`);
        } else {
          console.log(`   ⚠️  UNCLEAR: Both or neither reference each other`);
        }
      } catch (error) {
        console.log(`❌ Error examining ${taskA}/${taskB}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error("❌ Spec analysis failed:", error.message);
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
