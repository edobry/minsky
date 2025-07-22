#!/usr/bin/env bun

/**
 * Test script to validate workspace resolver performance improvements
 * This script tests different resolution modes and measures their performance
 */

import { performance } from "perf_hooks";
import { resolveTaskWorkspacePath } from "../src/utils/workspace-resolver";

interface TestResult {
  mode: string;
  duration: number;
  success: boolean;
  workspacePath: string;
  error?: string;
}

async function testWorkspaceResolver(): Promise<void> {
  console.log("🧪 Testing workspace resolver performance improvements\n");

  const tests: Array<{ name: string; options: any }> = [
    {
      name: "Emergency Mode (should be instant)",
      options: { emergencyMode: true }
    },
    {
      name: "Disabled Special Workspace (should be fast)",
      options: { disableSpecialWorkspace: true }
    },
    {
      name: "Normal Mode with 1s timeout",
      options: { maxResolutionTime: 1000 }
    },
    {
      name: "Normal Mode with 2s timeout (default)",
      options: {}
    }
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    console.log(`⏱️  Testing: ${test.name}`);
    const start = performance.now();
    let success = false;
    let workspacePath = "";
    let error: string | undefined;

    try {
      workspacePath = await resolveTaskWorkspacePath(test.options);
      success = true;
      console.log(`   ✅ Success: ${workspacePath}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ Error: ${error}`);
    }

    const duration = performance.now() - start;
    console.log(`   ⏱️  Duration: ${duration.toFixed(2)}ms\n`);

    results.push({
      mode: test.name,
      duration,
      success,
      workspacePath,
      error
    });
  }

  // Generate report
  console.log("📊 Performance Report:");
  console.log("=" .repeat(60));
  
  results.forEach(result => {
    const status = result.success ? "✅" : "❌";
    console.log(`${status} ${result.mode}`);
    console.log(`   Duration: ${result.duration.toFixed(2)}ms`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    console.log();
  });

  // Performance analysis
  const fastModes = results.filter(r => r.duration < 100);
  const slowModes = results.filter(r => r.duration > 1000);

  console.log("🎯 Analysis:");
  if (fastModes.length > 0) {
    console.log(`✅ Fast modes (< 100ms): ${fastModes.length}/${results.length}`);
  }
  if (slowModes.length > 0) {
    console.log(`⚠️  Slow modes (> 1s): ${slowModes.length}/${results.length}`);
  } else {
    console.log("✅ All modes completed in < 1 second");
  }

  const allSuccessful = results.every(r => r.success);
  console.log(`${allSuccessful ? "✅" : "❌"} Overall success rate: ${results.filter(r => r.success).length}/${results.length}`);
}

if (import.meta.main) {
  testWorkspaceResolver().catch(console.error);
} 
