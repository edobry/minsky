#!/usr/bin/env bun

/**
 * Test script to verify session path detection with complex paths
 *
 * This script tests the improvements made to isSessionRepository
 * and getSessionFromRepo functions to handle complex nested session paths.
 */

import { isSessionRepository, getSessionFromRepo } from "./src/domain/workspace";
import { join } from "path";

async function testSessionDetection() {
  console.log("Testing session path detection with complex nested paths");
  console.log("--------------------------------------------------------");

  // Sample paths to test
  const testPaths = [
    // Legacy path format
    join(
      process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
      "minsky",
      "git",
      "repo",
      "session"
    ),

    // New format with sessions subdirectory
    join(
      process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
      "minsky",
      "git",
      "repo",
      "sessions",
      "session"
    ),

    // Complex nested path like in the bug
    join(
      process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
      "minsky",
      "git",
      "local",
      "minsky",
      "sessions",
      "task#027"
    ),

    // Even more deeply nested
    join(
      process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
      "minsky",
      "git",
      "org",
      "repo",
      "nested",
      "sessions",
      "feature-branch"
    ),

    // Non-session path
    "/Users/username/Projects/repo",

    // Current directory
    process.cwd(),
  ];

  // Test isSessionRepository for each path
  console.log("\nTesting isSessionRepository function:");
  for (const path of testPaths) {
    try {
      const isSession = await isSessionRepository(path);
      console.log(`${isSession ? "✅" : "❌"} ${path}`);
    } catch (error) {
      console.error(`❌ Error testing ${path}:`, error);
    }
  }

  // Provide details about the current directory
  console.log("\nCurrent directory details:");
  try {
    console.log(`Current directory: ${process.cwd()}`);
    const isCurrentDirSession = await isSessionRepository(process.cwd());

    console.log(`Is current directory a session repository? ${isCurrentDirSession ? "Yes" : "No"}`);

    if (isCurrentDirSession) {
      const sessionInfo = await getSessionFromRepo(process.cwd());
      console.log("Session information:", sessionInfo);
    }
  } catch (error) {
    console.error("Error getting current directory details:", error);
  }
}

testSessionDetection().catch((error) => {
  console.error("Error running tests:", error);
  process.exit(1);
});
