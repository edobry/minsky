#!/usr/bin/env bun

/**
 * Debug script for path parsing in session detection
 */

import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";

const execAsync = promisify(exec);

async function debugPathParsing() {
  try {
    const cwd = process.cwd();
    console.log(`Current directory: ${cwd}`);
    
    // Get the git root of the provided path
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
    const gitRoot = stdout.trim();
    console.log(`\nGit root: ${gitRoot}`);
    
    // Check if the git root contains a session marker
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyPath = join(xdgStateHome, "minsky", "git");
    console.log(`\nMinsky path: ${minskyPath}`);
    
    // Debug startsWith check
    console.log(`\nDoes git root start with minsky path? ${gitRoot.startsWith(minskyPath)}`);
    
    if (gitRoot.startsWith(minskyPath)) {
      // Extract the relative path from the minsky git directory
      const relativePath = gitRoot.substring(minskyPath.length + 1);
      console.log(`\nRelative path from minsky git: ${relativePath}`);
      
      const pathParts = relativePath.split("/");
      console.log(`\nPath parts (${pathParts.length}):`);
      pathParts.forEach((part, i) => console.log(`  ${i}: ${part}`));
      
      // Check the exact condition from isSessionRepository
      const condition = pathParts.length >= 2 && (
        pathParts.length === 2 || 
        (pathParts.length >= 3 && pathParts[1] === "sessions")
      );
      
      console.log(`\nCondition check result: ${condition}`);
      console.log(`  - pathParts.length >= 2: ${pathParts.length >= 2}`);
      console.log(`  - pathParts.length === 2: ${pathParts.length === 2}`);
      if (pathParts.length >= 3) {
        console.log(`  - pathParts[1] === "sessions": ${pathParts[1] === "sessions"}`);
      }
      
      // If we fail the condition, suggest the expected path format
      if (!condition) {
        console.log("\nExpected path formats:");
        console.log(`  - Legacy: ${minskyPath}/<repoName>/<session>`);
        console.log(`  - New: ${minskyPath}/<repoName>/sessions/<session>`);
      }
    } else {
      console.log("\nPath does not start with minsky path prefix!");
      
      // Debug prefix matching
      const gitRootParts = gitRoot.split("/");
      const minskyPathParts = minskyPath.split("/");
      
      console.log("\nComparing path parts:");
      for (let i = 0; i < Math.min(gitRootParts.length, minskyPathParts.length); i++) {
        console.log(`  ${i}: ${gitRootParts[i]} ${gitRootParts[i] === minskyPathParts[i] ? "✓" : "✗"} ${minskyPathParts[i]}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

debugPathParsing(); 
