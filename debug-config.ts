#!/usr/bin/env bun

/**
 * Debug script to see why configuration loading is failing
 */

async function debugConfigLoading() {
  console.log("🔍 Debugging Configuration Loading...\n");

  try {
    console.log("1️⃣ Testing async import...");
    const { ConfigurationLoader } = await import("./src/domain/configuration/loader");
    console.log("✅ Import successful");

    console.log("\n2️⃣ Creating ConfigurationLoader...");
    const configLoader = new ConfigurationLoader();
    console.log("✅ ConfigurationLoader created");

    console.log("\n3️⃣ Loading configuration...");
    const configResult = await configLoader.load();
    console.log("✅ Configuration loaded");
    console.log("   Success:", configResult.success);
    console.log("   Keys:", Object.keys(configResult));
    console.log("   Has config?:", !!configResult.config);
    console.log("   Has data?:", !!configResult.data);
    console.log("   Config:", JSON.stringify(configResult.config, null, 2));

    if (configResult.config.tasks?.backend) {
      console.log("\n4️⃣ Backend found:", configResult.config.tasks.backend);
    } else {
      console.log("\n❌ Backend not found in configuration");
      console.log("   Tasks config:", configResult.config.tasks);
    }
  } catch (error) {
    console.error("\n❌ Configuration loading failed:");
    console.error("   Error:", error);
    console.error("   Stack:", error instanceof Error ? error.stack : "No stack trace");
  }
}

debugConfigLoading();
