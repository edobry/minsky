#!/usr/bin/env bun

/**
 * Test Context Pollution Reduction
 *
 * Validates that the updated tool-schemas component successfully reduces
 * context pollution when user queries are provided.
 */

import { ToolSchemasComponent } from "/Users/edobry/Projects/minsky/src/domain/context/components/tool-schemas";
import { createLogger } from "/Users/edobry/Projects/minsky/src/utils/logger";

const log = createLogger("test-context-reduction");

async function testContextReduction() {
  try {
    log.info("🧪 Testing Context Pollution Reduction");

    // Test 1: Context generation WITHOUT user query (baseline)
    log.info("\n1️⃣ Testing baseline (no query filtering):");

    const baselineInputs = await ToolSchemasComponent.gatherInputs({
      // No userQuery - should include all tools
    });

    const baselineOutput = ToolSchemasComponent.render(baselineInputs, {});

    log.info(`   Tools included: ${baselineInputs.totalTools}`);
    log.info(`   Content length: ${baselineOutput.content.length} characters`);
    log.info(`   Estimated tokens: ${baselineOutput.metadata.tokenCount}`);
    log.info(`   Filtered by: ${baselineInputs.filteredBy || "none"}`);

    // Test 2: Context generation WITH debug query
    log.info("\n2️⃣ Testing query-aware filtering (debug query):");

    const debugQuery = "help me debug a failing test";
    const debugInputs = await ToolSchemasComponent.gatherInputs({
      userQuery: debugQuery,
    });

    const debugOutput = ToolSchemasComponent.render(debugInputs, {
      userQuery: debugQuery,
    });

    log.info(`   Query: "${debugQuery}"`);
    log.info(`   Tools included: ${debugInputs.totalTools}`);
    log.info(`   Original tool count: ${debugInputs.originalToolCount}`);
    log.info(`   Reduction: ${debugInputs.reductionPercentage}%`);
    log.info(`   Content length: ${debugOutput.content.length} characters`);
    log.info(`   Estimated tokens: ${debugOutput.metadata.tokenCount}`);
    log.info(`   Filtered by: ${debugInputs.filteredBy}`);

    // Test 3: Context generation WITH tasks query
    log.info("\n3️⃣ Testing query-aware filtering (tasks query):");

    const tasksQuery = "list my current tasks and update their status";
    const tasksInputs = await ToolSchemasComponent.gatherInputs({
      userQuery: tasksQuery,
    });

    const tasksOutput = ToolSchemasComponent.render(tasksInputs, {
      userQuery: tasksQuery,
    });

    log.info(`   Query: "${tasksQuery}"`);
    log.info(`   Tools included: ${tasksInputs.totalTools}`);
    log.info(`   Original tool count: ${tasksInputs.originalToolCount}`);
    log.info(`   Reduction: ${tasksInputs.reductionPercentage}%`);
    log.info(`   Content length: ${tasksOutput.content.length} characters`);
    log.info(`   Estimated tokens: ${tasksOutput.metadata.tokenCount}`);
    log.info(`   Filtered by: ${tasksInputs.filteredBy}`);

    // Calculate overall improvement
    log.info("\n📊 Context Pollution Reduction Summary:");

    const debugReduction = baselineOutput.metadata.tokenCount! - debugOutput.metadata.tokenCount!;
    const debugReductionPercent = Math.round((debugReduction / baselineOutput.metadata.tokenCount!) * 100);

    const tasksReduction = baselineOutput.metadata.tokenCount! - tasksOutput.metadata.tokenCount!;
    const tasksReductionPercent = Math.round((tasksReduction / baselineOutput.metadata.tokenCount!) * 100);

    log.info(`   Baseline (no filtering): ${baselineOutput.metadata.tokenCount} tokens`);
    log.info(`   Debug query filtering: ${debugOutput.metadata.tokenCount} tokens (${debugReductionPercent}% reduction)`);
    log.info(`   Tasks query filtering: ${tasksOutput.metadata.tokenCount} tokens (${tasksReductionPercent}% reduction)`);

    // Success criteria
    const targetReduction = 30; // Target minimum 30% reduction
    const achievedTargetDebug = debugReductionPercent >= targetReduction;
    const achievedTargetTasks = tasksReductionPercent >= targetReduction;

    log.info(`\n✅ Results:`);
    log.info(`   Debug query: ${achievedTargetDebug ? "✅ PASSED" : "❌ FAILED"} (${debugReductionPercent}% reduction, target: ${targetReduction}%+)`);
    log.info(`   Tasks query: ${achievedTargetTasks ? "✅ PASSED" : "❌ FAILED"} (${tasksReductionPercent}% reduction, target: ${targetReduction}%+)`);

    if (achievedTargetDebug && achievedTargetTasks) {
      log.info(`\n🎉 Context pollution reduction test PASSED!`);
      log.info(`   Successfully achieved ${targetReduction}%+ token reduction target`);
    } else {
      log.info(`\n⚠️  Context pollution reduction test PARTIAL SUCCESS`);
      log.info(`   Some queries did not achieve ${targetReduction}%+ reduction target`);
    }

  } catch (error) {
    log.error("❌ Context pollution reduction test failed:", error);
    throw error;
  }
}

// Run the test
testContextReduction().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
