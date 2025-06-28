#!/usr/bin/env bun

/**
 * Debug Configuration Loading
 */

import { configurationService } from "./src/domain/configuration/index.js";

async function debugConfig() {
  console.log("🔍 Configuration Loading Debug");
  console.log("=" .repeat(50));

  try {
    // Test 1: Load from home directory
    console.log("\n📁 Test 1: Loading from HOME directory");
    const homeDir = process.env.HOME || "~";
    console.log(`   Home directory: ${homeDir}`);
    
    const configResult1 = await configurationService.loadConfiguration(homeDir);
    console.log(`   Resolved backend: ${configResult1.resolved.backend}`);
    console.log(`   SessionDB backend: ${configResult1.resolved.sessiondb.backend}`);
    console.log(`   SessionDB path: ${configResult1.resolved.sessiondb.dbPath}`);
    
    // Test 2: Load from current directory
    console.log("\n📁 Test 2: Loading from current directory");
    const currentDir = process.cwd();
    console.log(`   Current directory: ${currentDir}`);
    
    const configResult2 = await configurationService.loadConfiguration(currentDir);
    console.log(`   Resolved backend: ${configResult2.resolved.backend}`);
    console.log(`   SessionDB backend: ${configResult2.resolved.sessiondb.backend}`);
    console.log(`   SessionDB path: ${configResult2.resolved.sessiondb.dbPath}`);
    
    // Test 3: Check sources
    console.log("\n📋 Test 3: Configuration sources");
    console.log(`   Global user config loaded: ${configResult1.sources.globalUser ? "YES" : "NO"}`);
    console.log(`   Repository config loaded: ${configResult1.sources.repository ? "YES" : "NO"}`);
    
    if (configResult1.sources.globalUser) {
      console.log(`   Global user config version: ${configResult1.sources.globalUser.version}`);
      console.log(`   Global sessiondb: ${JSON.stringify(configResult1.sources.globalUser.sessiondb, null, 4)}`);
    }
    
    if (configResult1.sources.repository) {
      console.log(`   Repository config version: ${configResult1.sources.repository.version}`);
      console.log(`   Repository sessiondb: ${JSON.stringify(configResult1.sources.repository.sessiondb, null, 4)}`);
    }

  } catch (error) {
    console.error("\n❌ Configuration debug failed:", error);
    process.exit(1);
  }
}

debugConfig(); 
