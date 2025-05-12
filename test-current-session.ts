#!/usr/bin/env bun

/**
 * Direct test for getCurrentSession functionality
 */

import { getCurrentSession } from "./src/domain/workspace";

async function testGetCurrentSession() {
  try {
    console.log("Testing getCurrentSession function directly...\n");

    // Get the current directory
    const pwd = process.cwd();
    console.log(`Current directory: ${pwd}`);

    // Call getCurrentSession directly
    console.log("\nCalling getCurrentSession()...");
    const sessionName = await getCurrentSession();

    if (sessionName) {
      console.log(`✅ Successfully detected current session: "${sessionName}"`);
    } else {
      console.log("❌ getCurrentSession returned null - not in a session workspace");
    }

    // Call with explicit path to verify behavior in non-session directory
    console.log("\nTesting with explicit non-session path...");
    const homeDir = process.env.HOME || "";
    const nonSessionResult = await getCurrentSession(homeDir);

    if (nonSessionResult === null) {
      console.log("✅ Correctly returned null for non-session directory");
    } else {
      console.log(
        `❌ Unexpectedly detected session "${nonSessionResult}" for non-session directory`
      );
    }

    console.log("\nTest completed!");
  } catch (error) {
    console.error("Error during testing:", error);
    process.exit(1);
  }
}

testGetCurrentSession();
