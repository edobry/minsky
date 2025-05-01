#!/usr/bin/env bun

/**
 * Test script for updated workspace functions
 */

import { isSessionRepository, getSessionFromRepo, getCurrentSession } from "./src/domain/workspace";

async function testFixedFunctions() {
  try {
    const cwd = process.cwd();
    console.log(`Current directory: ${cwd}`);
    
    // Test isSessionRepository
    console.log("\nTesting isSessionRepository...");
    const isSessionRepo = await isSessionRepository(cwd);
    console.log(`isSessionRepository result: ${isSessionRepo}`);
    
    // Test getSessionFromRepo
    console.log("\nTesting getSessionFromRepo...");
    const sessionInfo = await getSessionFromRepo(cwd);
    console.log("getSessionFromRepo result:");
    console.log(JSON.stringify(sessionInfo, null, 2));
    
    // Test getCurrentSession
    console.log("\nTesting getCurrentSession...");
    const sessionName = await getCurrentSession(cwd);
    console.log(`getCurrentSession result: ${sessionName}`);
    
    console.log("\nTest completed!");
  } catch (error) {
    console.error("Error during testing:", error);
  }
}

testFixedFunctions(); 
