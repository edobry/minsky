#!/usr/bin/env bun

/**
 * Test script to verify the simplified minsky.json config format works
 */

import { ProjectConfigReader } from "./src/domain/project/config-reader";
import { resolve } from "path";

async function testSimplifiedConfig() {
  console.log("🧪 Testing simplified minsky.json config format...\n");

  const sessionRoot = resolve(__dirname);
  const configReader = new ProjectConfigReader(sessionRoot);

  try {
    // Test that we can load the simplified config
    const config = await configReader.getConfiguration();
    console.log("✅ Configuration loaded successfully!");
    console.log(`📄 Config source: ${config.configSource}`);
    console.log(`🔧 Workflows found: ${Object.keys(config.workflows).join(", ")}`);

    // Test specific commands
    const lintJsonCommand = await configReader.getLintJsonCommand();
    console.log(`🔍 Lint JSON command: ${lintJsonCommand}`);

    const lintCommand = await configReader.getLintCommand();
    console.log(`🔧 Lint command: ${lintCommand}`);

    // Verify the simplified format was detected and converted properly
    if (config.configSource === "minsky.json") {
      console.log("\n✅ Simplified minsky.json format detected and processed!");

      if (config.workflows.lintJson === "eslint . --format json") {
        console.log("✅ lintJson command correctly extracted from simplified format");
      } else {
        console.log(
          `❌ Expected lintJson to be 'eslint . --format json', got: ${config.workflows.lintJson}`
        );
      }

      if (config.workflows.lintFix === "eslint . --fix") {
        console.log("✅ lintFix command correctly extracted from simplified format");
      } else {
        console.log(`❌ Expected lintFix to be 'eslint . --fix', got: ${config.workflows.lintFix}`);
      }
    } else {
      console.log(`❌ Expected config source to be 'minsky.json', got: ${config.configSource}`);
    }
  } catch (error) {
    console.error("❌ Error testing simplified config:", error);
    process.exit(1);
  }
}

testSimplifiedConfig()
  .then(() => {
    console.log("\n🎉 Simplified config format test completed!");
  })
  .catch((error) => {
    console.error("❌ Test failed:", error);
    process.exit(1);
  });
