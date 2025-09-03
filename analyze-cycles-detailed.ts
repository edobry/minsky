#!/usr/bin/env bun

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function analyzeTaskLogic(taskService: any, taskId: string) {
  try {
    const task = await taskService.getTask(taskId);
    return {
      id: taskId,
      title: task?.title || "Unknown",
      spec: task?.spec || "",
      status: task?.status || "Unknown",
    };
  } catch (error) {
    console.log(`❌ Could not load ${taskId}: ${error.message}`);
    return null;
  }
}

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

    // Analyze each cycle in detail
    const cyclePairs = [
      ["mt#237", "mt#239"], // Hierarchical Task System ↔ Task Dependencies
      ["mt#237", "mt#240"], // Hierarchical Task System ↔ Enhanced Planning
      ["mt#251", "mt#252"], // Mobile Interface ↔ Task Management UI
      ["mt#284", "mt#260"], // Task Graph Integration ↔ Prompt Templates
    ];

    console.log("📊 DETAILED CYCLE ANALYSIS\n");

    for (const [taskA, taskB] of cyclePairs) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`🔄 ANALYZING CYCLE: ${taskA} ↔ ${taskB}`);
      console.log(`${"=".repeat(60)}`);

      const [detailsA, detailsB] = await Promise.all([
        analyzeTaskLogic(taskService, taskA),
        analyzeTaskLogic(taskService, taskB),
      ]);

      if (!detailsA || !detailsB) continue;

      console.log(`\n📋 ${taskA}: ${detailsA.title}`);
      console.log(`   Status: ${detailsA.status}`);
      if (detailsA.spec.length > 0) {
        console.log(`   Spec: ${detailsA.spec.substring(0, 300)}...`);
      }

      console.log(`\n📋 ${taskB}: ${detailsB.title}`);
      console.log(`   Status: ${detailsB.status}`);
      if (detailsB.spec.length > 0) {
        console.log(`   Spec: ${detailsB.spec.substring(0, 300)}...`);
      }

      // Analysis based on titles and logical dependency flow
      console.log(`\n🧠 LOGICAL ANALYSIS:`);

      // Determine logical precedence based on task nature
      let suggestion = "";
      if (taskA === "mt#237" && taskB === "mt#239") {
        suggestion =
          "mt#237 should depend on mt#239 (hierarchical system needs basic dependencies first)";
      } else if (taskA === "mt#237" && taskB === "mt#240") {
        suggestion =
          "mt#237 should depend on mt#239, mt#240 should depend on mt#237 (enhanced features build on basic)";
      } else if (taskA === "mt#251" && taskB === "mt#252") {
        suggestion = "mt#251 should depend on mt#252 (mobile interface needs UI system first)";
      } else if (taskA === "mt#284" && taskB === "mt#260") {
        suggestion =
          "mt#284 might depend on mt#260 (integration might need templates) OR unrelated";
      }

      console.log(`   ${suggestion}`);
    }
  } catch (error) {
    console.error("❌ Analysis failed:", error.message);
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
