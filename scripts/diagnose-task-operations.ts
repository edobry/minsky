#!/usr/bin/env bun

/**
 * Diagnostic script to reproduce and measure task operation hanging issues
 * This script will help identify which specific operations are causing delays
 */

import { performance } from "perf_hooks";
import { autoCommitTaskChanges } from "../src/utils/auto-commit";
import { execGitWithTimeout } from "../src/utils/git-exec";
import { log } from "../src/utils/logger";

interface OperationTiming {
  operation: string;
  duration: number;
  success: boolean;
  details?: any;
}

class TaskOperationProfiler {
  private timings: OperationTiming[] = [];

  async measureOperation<T>(
    name: string,
    operation: () => Promise<T>
  ): Promise<{ result: T; timing: OperationTiming }> {
    const start = performance.now();
    let success = false;
    let result: T;
    let error: any;

    try {
      result = await operation();
      success = true;
    } catch (e) {
      error = e;
      throw e;
    } finally {
      const duration = performance.now() - start;
      const timing: OperationTiming = {
        operation: name,
        duration,
        success,
        details: error ? { error: error.message } : undefined,
      };
      this.timings.push(timing);

      console.log(`⏱️  ${name}: ${duration.toFixed(2)}ms ${success ? "✅" : "❌"}`);
      if (error) {
        console.log(`   Error: ${error.message}`);
      }
    }

    return { result: result!, timing: this.timings[this.timings.length - 1] };
  }

  getTimings(): OperationTiming[] {
    return this.timings;
  }

  getReport(): string {
    const total = this.timings.reduce((sum, t) => sum + t.duration, 0);
    const slowOperations = this.timings
      .filter((t) => t.duration > 1000)
      .sort((a, b) => b.duration - a.duration);

    let report = "\n📊 Performance Report:\n";
    report += `Total time: ${total.toFixed(2)}ms\n`;
    report += `Operations: ${this.timings.length}\n`;
    report += `Average: ${(total / this.timings.length).toFixed(2)}ms\n\n`;

    if (slowOperations.length > 0) {
      report += "🐌 Slow operations (>1s):\n";
      slowOperations.forEach((op) => {
        report += `  ${op.operation}: ${op.duration.toFixed(2)}ms\n`;
      });
    }

    return report;
  }
}

async function diagnoseTaskOperations() {
  const profiler = new TaskOperationProfiler();
  const testWorkspace = process.cwd();

  console.log("🔍 Starting Task Operations Diagnostic");
  console.log(`📁 Test workspace: ${testWorkspace}`);
  console.log();

  try {
    // Test 1: Basic git status check
    await profiler.measureOperation("git-status-check", async () => {
      return await execGitWithTimeout("status-check", "status --porcelain", {
        workdir: testWorkspace,
      });
    });

    // Test 2: Git add operation
    await profiler.measureOperation("git-add-process-tasks", async () => {
      return await execGitWithTimeout("add-test", "add process/tasks.md", {
        workdir: testWorkspace,
      });
    });

    // Test 3: Check staged files
    await profiler.measureOperation("git-diff-cached", async () => {
      return await execGitWithTimeout("diff-cached", "diff --cached --name-only", {
        workdir: testWorkspace,
      });
    });

    // Test 4: Reset any staged changes (cleanup)
    await profiler.measureOperation("git-reset", async () => {
      return await execGitWithTimeout("reset", "reset HEAD", { workdir: testWorkspace });
    });

    // Test 5: Auto-commit with no changes (should be fast)
    await profiler.measureOperation("auto-commit-no-changes", async () => {
      return await autoCommitTaskChanges(
        testWorkspace,
        "test: diagnostic commit (no changes expected)"
      );
    });

    // Test 6: Check if special workspace operations are involved
    await profiler.measureOperation("special-workspace-check", async () => {
      const specialWorkspacePath = "~/.local/state/minsky/task-operations/";
      try {
        return await execGitWithTimeout("status-check-special", "status --porcelain", {
          workdir: specialWorkspacePath,
        });
      } catch (error) {
        return { stdout: "No special workspace found", stderr: "" };
      }
    });
  } catch (error) {
    console.error(`❌ Diagnostic failed: ${error}`);
  }

  console.log(profiler.getReport());

  // Check for potential hanging scenarios
  console.log("\n🔧 Potential Issues Analysis:");

  const gitOperations = profiler.getTimings().filter((t) => t.operation.includes("git"));
  const slowGitOps = gitOperations.filter((t) => t.duration > 500);

  if (slowGitOps.length > 0) {
    console.log("⚠️  Slow git operations detected:");
    slowGitOps.forEach((op) => {
      console.log(`   ${op.operation}: ${op.duration.toFixed(2)}ms`);
    });
  }

  const totalGitTime = gitOperations.reduce((sum, t) => sum + t.duration, 0);
  console.log(`📈 Total git operation time: ${totalGitTime.toFixed(2)}ms`);

  if (totalGitTime > 2000) {
    console.log("🚨 Git operations are taking longer than 2 seconds!");
    console.log("   This could explain the hanging issues users experience.");
  }
}

if (import.meta.main) {
  diagnoseTaskOperations().catch(console.error);
}
