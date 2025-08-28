#!/usr/bin/env bun

/**
 * Test Tool Similarity Service
 * 
 * Validates that the ToolSimilarityService works correctly with various user queries.
 * Tests both semantic matching and keyword fallback mechanisms.
 */

import { createToolSimilarityService } from "/Users/edobry/Projects/minsky/src/domain/tools/similarity/tool-similarity-service";
import { createLogger } from "/Users/edobry/Projects/minsky/src/utils/logger";

const log = createLogger("test-tool-similarity");

async function testToolSimilarity() {
  try {
    log.info("🧪 Testing Tool Similarity Service");
    
    const service = await createToolSimilarityService();
    
    // Test queries that should match different tool categories
    const testQueries = [
      {
        query: "help me debug a failing test",
        expectedCategories: ["DEBUG", "TASKS"],
        description: "Debug-related query"
      },
      {
        query: "list my current tasks",
        expectedCategories: ["TASKS"],
        description: "Task management query"
      },
      {
        query: "commit my changes to git",
        expectedCategories: ["GIT"],
        description: "Git operations query"
      },
      {
        query: "start a new session",
        expectedCategories: ["SESSION"],
        description: "Session management query"
      },
      {
        query: "configure my settings",
        expectedCategories: ["CONFIG"],
        description: "Configuration query"
      },
      {
        query: "review this pull request",
        expectedCategories: ["GIT", "TASKS"],
        description: "Code review query"
      },
      {
        query: "implement user authentication",
        expectedCategories: ["TASKS", "CONFIG"],
        description: "Implementation query"
      }
    ];

    log.info(`Testing ${testQueries.length} queries...\n`);

    for (const testCase of testQueries) {
      log.info(`🔍 Query: "${testCase.query}"`);
      log.info(`   Expected categories: ${testCase.expectedCategories.join(", ")}`);
      
      const results = await service.findRelevantTools({
        query: testCase.query,
        limit: 5,
        threshold: 0.1
      });
      
      log.info(`   Found ${results.length} relevant tools:`);
      
      for (const result of results.slice(0, 3)) { // Show top 3
        log.info(`     • ${result.tool.name} (${result.tool.category}) - Score: ${result.relevanceScore.toFixed(3)}`);
        log.info(`       ${result.tool.description}`);
        log.info(`       Reason: ${result.reason}`);
      }
      
      // Check if we found tools from expected categories
      const foundCategories = [...new Set(results.map(r => r.tool.category))];
      const hasExpectedCategory = testCase.expectedCategories.some(cat => 
        foundCategories.includes(cat)
      );
      
      if (hasExpectedCategory) {
        log.info(`   ✅ Found tools from expected categories`);
      } else {
        log.info(`   ⚠️  No tools from expected categories found`);
        log.info(`   Found categories: ${foundCategories.join(", ")}`);
      }
      
      log.info(""); // Empty line for readability
    }

    // Test backend usage
    const backend = await service.getLastUsedBackend();
    log.info(`🔧 Last used backend: ${backend || "none"}`);
    
    log.info("✅ Tool similarity service test completed successfully!");
    
  } catch (error) {
    log.error("❌ Tool similarity service test failed:", error);
    throw error;
  }
}

// Run the test
testToolSimilarity().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
