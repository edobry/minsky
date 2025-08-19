#!/usr/bin/env bun

/**
 * Simple test script for context analysis functionality
 */

import { createTokenizationService } from "./src/domain/ai/tokenization";
import { ContextAnalysisService } from "./src/domain/context/analysis-service";

async function testContextAnalysis() {
  console.log("🧪 Testing Context Analysis Implementation");
  console.log("=".repeat(50));

  try {
    // Initialize services
    console.log("📦 Initializing tokenization service...");
    const tokenizationService = createTokenizationService();

    console.log("📊 Initializing analysis service...");
    const analysisService = new ContextAnalysisService(tokenizationService);

    // Test basic tokenization
    console.log("🔢 Testing basic tokenization...");
    const testText = "Hello world, this is a test for token counting.";
    const tokenCount = await tokenizationService.countTokens(testText, "gpt-4o");
    console.log(`✅ Text: "${testText}"`);
    console.log(`✅ Token count: ${tokenCount}`);

    // Test tokenizer comparison
    console.log("🔄 Testing tokenizer comparison...");
    const comparison = await tokenizationService.compareTokenizers(testText, "gpt-4o");
    console.log(`✅ Found ${comparison.length} available tokenizers`);

    for (const comp of comparison) {
      const status = comp.success ? "✅" : "❌";
      console.log(
        `  ${status} ${comp.tokenizer.name}: ${comp.tokenCount} tokens (${comp.duration}ms)`
      );
    }

    // Test context analysis
    console.log("📋 Testing context analysis...");
    const analysisRequest = {
      model: "gpt-4o",
      workspacePath: process.cwd(),
      options: {
        compareTokenizers: true,
        includeOptimizations: true,
      },
    };

    const result = await analysisService.analyzeContext(analysisRequest);

    console.log("📊 Analysis Results:");
    console.log(`  Total tokens: ${result.summary.totalTokens}`);
    console.log(`  Total elements: ${result.summary.totalElements}`);
    console.log(`  Context utilization: ${result.summary.utilizationPercentage.toFixed(1)}%`);
    console.log(`  Analysis time: ${result.performance.analysisTime}ms`);

    // Show breakdown
    console.log("📁 Element breakdown:");
    for (const [type, stats] of Object.entries(result.breakdown)) {
      if (stats) {
        console.log(`  ${type}: ${stats.count} elements, ${stats.tokens} tokens`);
      }
    }

    // Show top elements
    console.log("🔝 Top elements by token count:");
    const topElements = result.elements.slice(0, 3);
    for (const { element, tokenCount, percentage } of topElements) {
      console.log(`  ${element.name}: ${tokenCount} tokens (${percentage.toFixed(1)}%)`);
    }

    console.log("\n🎉 Context analysis test completed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Run the test
testContextAnalysis();
