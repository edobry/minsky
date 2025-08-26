#!/usr/bin/env bun

/**
 * Test Quality CLI Tool
 *
 * Provides commands to analyze test quality, detect flaky tests,
 * and generate performance reports.
 */

import { testMonitor } from "./test-monitor";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const MONITOR_DATA_FILE = join(process.cwd(), ".test-monitor-data.json");

function loadMonitorData() {
  if (existsSync(MONITOR_DATA_FILE)) {
    try {
      const data = readFileSync(MONITOR_DATA_FILE, "utf-8");
      testMonitor.importData(data);
      console.log("📊 Loaded existing test monitoring data");
    } catch (error) {
      console.warn("⚠️ Failed to load test monitoring data:", error);
    }
  }
}

function saveMonitorData() {
  try {
    const data = testMonitor.exportData();
    writeFileSync(MONITOR_DATA_FILE, data);
    console.log("💾 Saved test monitoring data");
  } catch (error) {
    console.error("❌ Failed to save test monitoring data:", error);
  }
}

function showQualityReport() {
  loadMonitorData();

  const report = testMonitor.generateQualityReport();

  console.log("\n🔍 TEST QUALITY REPORT\n");
  console.log(`📊 Total Tests: ${report.totalTests}`);
  console.log(`🟡 Flaky Tests: ${report.flakyTests}`);
  console.log(`🐌 Slow Tests: ${report.slowTests}`);
  console.log(`🔴 Critical Tests: ${report.criticalTests}`);
  console.log(`⏱️  Average Duration: ${report.averageTestDuration.toFixed(0)}ms`);

  if (report.worstOffenders.length > 0) {
    console.log("\n🚨 WORST OFFENDERS:\n");

    report.worstOffenders.forEach((offender, index) => {
      const icon =
        offender.metrics.category === "flaky"
          ? "🔄"
          : offender.metrics.category === "critical"
            ? "🔴"
            : "🐌";

      console.log(`${index + 1}. ${icon} ${offender.testName}`);
      console.log(`   📁 ${offender.filePath}`);
      console.log(`   📋 ${offender.reason}`);
      console.log(
        `   🔢 Runs: ${offender.metrics.totalRuns}, Failures: ${offender.metrics.failures}`
      );
      console.log("");
    });
  }

  // Show recommendations
  console.log("💡 RECOMMENDATIONS:\n");

  if (report.flakyTests > 0) {
    console.log("🔄 Fix flaky tests by:");
    console.log("   - Adding proper test isolation");
    console.log("   - Fixing race conditions");
    console.log("   - Stabilizing external dependencies");
    console.log("");
  }

  if (report.slowTests > 0) {
    console.log("🐌 Improve slow tests by:");
    console.log("   - Mocking external services");
    console.log("   - Reducing test data size");
    console.log("   - Parallelizing independent operations");
    console.log("");
  }

  if (report.criticalTests > 0) {
    console.log("🔴 Address critical tests by:");
    console.log("   - Reviewing test logic and assumptions");
    console.log("   - Checking for environmental dependencies");
    console.log("   - Updating assertions to match current behavior");
    console.log("");
  }
}

function showFlakyTests() {
  loadMonitorData();

  const flakyTests = testMonitor.getFlakyTests();

  if (flakyTests.length === 0) {
    console.log("✅ No flaky tests detected!");
    return;
  }

  console.log("\n🔄 FLAKY TESTS DETECTED:\n");

  flakyTests.forEach((test, index) => {
    console.log(`${index + 1}. ${test.testName}`);
    console.log(`   📁 ${test.filePath}`);
    console.log(`   📊 Flakiness: ${(test.metrics.flakiness * 100).toFixed(1)}%`);
    console.log(`   🔢 ${test.metrics.failures}/${test.metrics.totalRuns} failures`);
    console.log(`   ⏱️  Avg Duration: ${test.metrics.averageDuration.toFixed(0)}ms`);

    if (test.metrics.lastFailure) {
      const lastFailureDate = new Date(test.metrics.lastFailure);
      console.log(`   🕒 Last Failure: ${lastFailureDate.toISOString()}`);
    }
    console.log("");
  });
}

function showSlowestTests() {
  loadMonitorData();

  const slowTests = testMonitor.getSlowestTests(15);

  if (slowTests.length === 0) {
    console.log("🚀 No slow tests detected!");
    return;
  }

  console.log("\n🐌 SLOWEST TESTS:\n");

  slowTests.forEach((test, index) => {
    console.log(`${index + 1}. ${test.testName}`);
    console.log(`   📁 ${test.filePath}`);
    console.log(`   ⏱️  Duration: ${test.metrics.averageDuration.toFixed(0)}ms`);
    console.log(`   🔢 Runs: ${test.metrics.totalRuns}`);
    console.log("");
  });
}

function resetMonitoringData() {
  if (existsSync(MONITOR_DATA_FILE)) {
    try {
      writeFileSync(MONITOR_DATA_FILE, JSON.stringify({ timestamp: Date.now(), executions: [] }));
      console.log("🧹 Reset test monitoring data");
    } catch (error) {
      console.error("❌ Failed to reset monitoring data:", error);
    }
  } else {
    console.log("ℹ️  No monitoring data to reset");
  }
}

function showHelp() {
  console.log(`
🔍 Test Quality CLI Tool

USAGE:
  bun tests/utils/test-quality-cli.ts <command>

COMMANDS:
  report      Show comprehensive test quality report
  flaky       List all detected flaky tests
  slow        List slowest tests
  reset       Reset monitoring data
  help        Show this help message

EXAMPLES:
  bun tests/utils/test-quality-cli.ts report
  bun tests/utils/test-quality-cli.ts flaky
  bun tests/utils/test-quality-cli.ts slow

DATA:
  Test data is automatically collected during test runs and stored in:
  ${MONITOR_DATA_FILE}
`);
}

// Main CLI logic
const command = process.argv[2];

switch (command) {
  case "report":
    showQualityReport();
    break;
  case "flaky":
    showFlakyTests();
    break;
  case "slow":
    showSlowestTests();
    break;
  case "reset":
    resetMonitoringData();
    break;
  case "help":
  default:
    showHelp();
    break;
}
