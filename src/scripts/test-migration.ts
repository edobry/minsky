#!/usr/bin/env bun

/**
 * Test Migration Script
 *
 * This script migrates test files from Jest/Vitest patterns to Bun test patterns.
 * It builds on the analysis data from test-analyzer.ts and applies transformation rules
 * to update test files to use Bun's native testing APIs.
 *
 * Usage:
 *   bun src/scripts/test-migration.ts [options]
 *
 * Options:
 *   --analysis-file=<path>    Path to the test analysis JSON file (default: test-analysis/test-analysis-report.json)
 *   --target=<path>           Specific test file or directory to migrate
 *   --difficulty=<level>      Only migrate tests with specified difficulty (easy, medium, hard)
 *   --dry-run                 Preview changes without applying them
 *   --backup                  Create backup files before migration (.bak extension)
 *   --verify                  Run tests before and after migration to verify functionality
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

// Promisify exec
const execAsync = promisify(exec);

// Get current directory
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const baseDir = resolve(__dirname, "../..");

// Configuration
const config = {
  analysisFile: "test-analysis/test-analysis-report.json",
  targetPath: "",
  difficultyFilter: "",
  dryRun: false,
  backup: true,
  verify: false,
};

// Parse command line arguments
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--analysis-file=")) {
    const value = arg.split("=")[1];
    if (value) config.analysisFile = value;
  } else if (arg.startsWith("--target=")) {
    const value = arg.split("=")[1];
    if (value) config.targetPath = value;
  } else if (arg.startsWith("--difficulty=")) {
    const value = arg.split("=")[1];
    if (value && ["easy", "medium", "hard"].includes(value)) {
      config.difficultyFilter = value;
    }
  } else if (arg === "--dry-run") {
    config.dryRun = true;
  } else if (arg === "--backup") {
    config.backup = true;
  } else if (arg === "--verify") {
    config.verify = true;
  }
}

// Interfaces from analyzer (simplified for migration purposes)
interface TestFileAnalysis {
  path: string;
  relativePath: string;
  classification: {
    migrationDifficulty: "easy" | "medium" | "hard";
  };
  imports: string[];
  mockDependencies: string[];
  counts: {
    mockPatterns: Record<string, number>;
    frameworkFeatures: Record<string, number>;
    assertionStyles: Record<string, number>;
  };
}

interface AnalysisReport {
  testFiles: TestFileAnalysis[];
}

// Define transformation types
interface Transformation {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...args: any[]) => string);
  checkOnly?: boolean;
  addImport?: string;
}

// Transformation patterns
const transformations: Transformation[] = [
  // Import transformations
  {
    name: "Replace Jest imports with Bun",
    pattern: /import\s+(.+)\s+from\s+['"]jest['"]/g,
    replacement: "import $1 from 'bun:test'",
  },
  {
    name: "Replace Vitest imports with Bun",
    pattern: /import\s+(.+)\s+from\s+['"]vitest['"]/g,
    replacement: "import $1 from 'bun:test'",
  },

  // Mock function transformations
  {
    name: "Replace jest.fn with mock.fn",
    pattern: /jest\.fn\(/g,
    replacement: "mock.fn(",
  },
  {
    name: "Replace vitest.fn with mock.fn",
    pattern: /vitest\.fn\(/g,
    replacement: "mock.fn(",
  },

  // Module mocking transformations
  {
    name: "Replace jest.mock with mock.module",
    pattern: /jest\.mock\((['"].+?['"])(,\s*\{[\s\S]+?\})?\)/g,
    replacement: "mock.module($1$2)",
  },
  {
    name: "Replace vitest.mock with mock.module",
    pattern: /vitest\.mock\((['"].+?['"])(,\s*\{[\s\S]+?\})?\)/g,
    replacement: "mock.module($1$2)",
  },

  // Spy transformations
  {
    name: "Replace jest.spyOn with createSpyOn",
    pattern: /jest\.spyOn\(([^,]+),\s*(['"].+?['"])\)/g,
    replacement: "createSpyOn($1, $2)",
  },
  {
    name: "Replace vitest.spyOn with createSpyOn",
    pattern: /vitest\.spyOn\(([^,]+),\s*(['"].+?['"])\)/g,
    replacement: "createSpyOn($1, $2)",
  },

  // Add missing mock import if needed
  {
    name: "Add mock import if mock.fn is used without import",
    pattern: /import .+ from ['"]bun:test['"];?(?!\s*import\s+\{\s*mock\s*\})/g,
    replacement: (match: string) => `${match}\nimport { mock } from 'bun:test';`,
  },
  {
    name: "Add createSpyOn import if spyOn is transformed",
    pattern: /createSpyOn\(/g,
    checkOnly: true, // Only check if pattern exists, don't replace
    addImport: "import { createSpyOn } from '../../../utils/test-utils/mocking';",
    // Add empty replacement to satisfy the interface
    replacement: "",
  },
];

/**
 * Helper function to run a command and capture output
 */
async function runCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command);
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  }
}

/**
 * Run a specific test file and return the result
 */
async function runTest(testFile: string): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await runCommand(`bun test ${testFile}`);
    const output = `${stdout  }\n${  stderr}`;
    const success = !output.includes("fail") && !output.includes("error");
    return { success, output };
  } catch (error: unknown) {
    const err = error as { message?: string };
    return { success: false, output: err.message || "Unknown error running test" };
  }
}

/**
 * Apply transformation patterns to a file's content
 */
function applyTransformations(
  content: string,
  testFile: TestFileAnalysis
): {
  transformed: string;
  changes: { pattern: string; count: number }[];
  addedImports: string[];
} {
  let transformed = content;
  const changes: { pattern: string; count: number }[] = [];
  const addedImports: string[] = [];

  for (const t of transformations) {
    if (t.checkOnly) {
      // Just check if pattern exists, don't replace
      if (t.pattern.test(transformed) && t.addImport) {
        // Check if the import is already present
        if (!transformed.includes(t.addImport)) {
          transformed = `${t.addImport  }\n${  transformed}`;
          addedImports.push(t.addImport);
          changes.push({ pattern: t.name, count: 1 });
        }
      }
      continue;
    }

    // Count occurrences before replacement
    const beforeCount = (transformed.match(t.pattern) || []).length;

    if (beforeCount > 0) {
      // Apply the transformation
      if (typeof t.replacement === "string") {
        transformed = transformed.replace(t.pattern, t.replacement);
      } else if (typeof t.replacement === "function") {
        transformed = transformed.replace(t.pattern, t.replacement);
      }

      // Count occurrences after replacement to confirm changes
      const afterMatches = transformed.match(t.pattern) || [];
      const afterCount = afterMatches.length;
      const replacedCount = beforeCount - afterCount;

      if (replacedCount > 0) {
        changes.push({ pattern: t.name, count: replacedCount });
      }
    }
  }

  return { transformed, changes, addedImports };
}

/**
 * Migrate a single test file
 */
async function migrateTestFile(
  testFile: TestFileAnalysis,
  dryRun: boolean,
  createBackup: boolean,
  verifyTests: boolean
): Promise<{
  success: boolean;
  changes: { pattern: string; count: number }[];
  addedImports: string[];
  verificationResult?: { before: { success: boolean }; after: { success: boolean } };
}> {
  try {
    // Read the file content
    const content = await readFile(testFile.path, "utf-8");

    // Apply transformations
    const { transformed, changes, addedImports } = applyTransformations(content, testFile);

    // Check if there were any changes
    if (content === transformed) {
      console.log(`  No changes needed for: ${testFile.relativePath}`);
      return { success: true, changes: [], addedImports: [] };
    }

    // Verify tests before migration if requested
    let verificationResult;
    if (verifyTests) {
      console.log(`  Verifying test before migration: ${testFile.relativePath}`);
      const beforeResult = await runTest(testFile.path);

      if (!dryRun) {
        // Create backup if requested
        if (createBackup) {
          await writeFile(`${testFile.path}.bak`, content);
          console.log(`  Created backup: ${testFile.path}.bak`);
        }

        // Write the transformed content
        await writeFile(testFile.path, transformed);
        console.log(`  Migrated: ${testFile.relativePath}`);

        // Verify tests after migration
        console.log(`  Verifying test after migration: ${testFile.relativePath}`);
        const afterResult = await runTest(testFile.path);

        verificationResult = {
          before: beforeResult,
          after: afterResult,
        };

        // If verification failed, restore from backup
        if (!afterResult.success && createBackup) {
          console.error("  ⚠️ Test failed after migration, restoring from backup");
          await writeFile(testFile.path, content);
          return {
            success: false,
            changes,
            addedImports,
            verificationResult,
          };
        }
      } else {
        console.log(`  [DRY RUN] Would migrate: ${testFile.relativePath}`);
      }
    } else {
      // No verification, just migrate
      if (!dryRun) {
        // Create backup if requested
        if (createBackup) {
          await writeFile(`${testFile.path}.bak`, content);
          console.log(`  Created backup: ${testFile.path}.bak`);
        }

        // Write the transformed content
        await writeFile(testFile.path, transformed);
        console.log(`  Migrated: ${testFile.relativePath}`);
      } else {
        console.log(`  [DRY RUN] Would migrate: ${testFile.relativePath}`);
      }
    }

    return {
      success: true,
      changes,
      addedImports,
      verificationResult,
    };
  } catch (error: unknown) {
    const err = error as Error;
    console.error(`  ❌ Error migrating ${testFile.relativePath}:`, err.message || err);
    return { success: false, changes: [], addedImports: [] };
  }
}

/**
 * Main migration function
 */
async function migrateTests() {
  try {
    console.log("Test Migration Script");
    console.log("--------------------");

    // Load the analysis report
    const analysisPath = resolve(baseDir, config.analysisFile);
    console.log(`Loading analysis from: ${analysisPath}`);

    if (!existsSync(analysisPath)) {
      console.error(`Analysis file not found: ${analysisPath}`);
      console.error("Run the test analyzer first: bun src/scripts/test-analyzer.ts");
      process.exit(1);
    }

    const analysisContent = await readFile(analysisPath, "utf-8");
    const analysis: AnalysisReport = JSON.parse(analysisContent);

    // Filter test files based on configuration
    let testFilesToMigrate = analysis.testFiles;

    if (config.targetPath) {
      const targetPath = resolve(baseDir, config.targetPath);
      testFilesToMigrate = testFilesToMigrate.filter(
        (file) => file.path === targetPath || file.path.startsWith(`${targetPath  }/`)
      );

      if (testFilesToMigrate.length === 0) {
        console.error(`No test files found matching target: ${config.targetPath}`);
        process.exit(1);
      }

      console.log(
        `Filtered to ${testFilesToMigrate.length} test files matching target: ${config.targetPath}`
      );
    }

    if (config.difficultyFilter) {
      testFilesToMigrate = testFilesToMigrate.filter(
        (file) => file.classification.migrationDifficulty === config.difficultyFilter
      );

      if (testFilesToMigrate.length === 0) {
        console.error(`No test files found with difficulty: ${config.difficultyFilter}`);
        process.exit(1);
      }

      console.log(
        `Filtered to ${testFilesToMigrate.length} test files with difficulty: ${config.difficultyFilter}`
      );
    }

    // Output configuration
    console.log("\nMigration Configuration:");
    console.log(`- Dry Run: ${config.dryRun ? "Yes" : "No"}`);
    console.log(`- Create Backups: ${config.backup ? "Yes" : "No"}`);
    console.log(`- Verify Tests: ${config.verify ? "Yes" : "No"}`);
    console.log(`- Target Files: ${testFilesToMigrate.length}`);

    // Create results directory
    const resultsDir = resolve(baseDir, "test-migration-results");
    if (!existsSync(resultsDir)) {
      await mkdir(resultsDir, { recursive: true });
    }

    // Migrate each test file
    console.log("\nStarting migration...");

    const migrationResults: Array<{
      file: string;
      success: boolean;
      changes: { pattern: string; count: number }[];
      addedImports: string[];
      verificationResult?: { before: { success: boolean }; after: { success: boolean } };
    }> = [];
    let successCount = 0;
    let failCount = 0;

    for (const [index, testFile] of testFilesToMigrate.entries()) {
      console.log(
        `\n[${index + 1}/${testFilesToMigrate.length}] Migrating: ${testFile.relativePath}`
      );

      const result = await migrateTestFile(testFile, config.dryRun, config.backup, config.verify);

      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }

      migrationResults.push({
        file: testFile.relativePath,
        success: result.success,
        changes: result.changes,
        addedImports: result.addedImports,
        verificationResult: result.verificationResult,
      });
    }

    // Generate migration report
    const migrationReport = {
      timestamp: new Date().toISOString(),
      configuration: {
        dryRun: config.dryRun,
        createBackups: config.backup,
        verifyTests: config.verify,
        targetPath: config.targetPath,
        difficultyFilter: config.difficultyFilter,
      },
      summary: {
        totalFiles: testFilesToMigrate.length,
        successCount,
        failCount,
      },
      results: migrationResults,
    };

    // Write migration report
    const reportPath = resolve(resultsDir, "migration-report.json");
    await writeFile(reportPath, JSON.stringify(migrationReport, null, 2));
    console.log(`\nMigration report written to: ${reportPath}`);

    // Generate markdown summary
    const mdReportPath = resolve(resultsDir, "migration-report.md");

    const md = [
      "# Test Migration Report",
      "",
      `Generated: ${new Date().toLocaleString()}`,
      "",
      "## Migration Summary",
      "",
      `- Total Files: ${migrationReport.summary.totalFiles}`,
      `- Successfully Migrated: ${migrationReport.summary.successCount}`,
      `- Failed Migrations: ${migrationReport.summary.failCount}`,
      "",
      "## Configuration",
      "",
      `- Dry Run: ${migrationReport.configuration.dryRun ? "Yes" : "No"}`,
      `- Create Backups: ${migrationReport.configuration.createBackups ? "Yes" : "No"}`,
      `- Verify Tests: ${migrationReport.configuration.verifyTests ? "Yes" : "No"}`,
      `- Target Path: ${migrationReport.configuration.targetPath || "All"}`,
      `- Difficulty Filter: ${migrationReport.configuration.difficultyFilter || "All"}`,
      "",
      "## Migration Results",
      "",
    ];

    for (const result of migrationResults) {
      md.push(`### ${result.file}`);
      md.push("");
      md.push(`Status: ${result.success ? "✅ Success" : "❌ Failed"}`);
      md.push("");

      if (result.changes.length > 0) {
        md.push("Changes:");
        md.push("");
        for (const change of result.changes) {
          md.push(`- ${change.pattern}: ${change.count} occurrences`);
        }
        md.push("");
      } else {
        md.push("No changes made");
        md.push("");
      }

      if (result.addedImports.length > 0) {
        md.push("Added imports:");
        md.push("");
        for (const imp of result.addedImports) {
          md.push(`- \`${imp}\``);
        }
        md.push("");
      }

      if (result.verificationResult) {
        md.push("Verification:");
        md.push("");
        md.push(`- Before: ${result.verificationResult.before.success ? "✅ Pass" : "❌ Fail"}`);
        md.push(`- After: ${result.verificationResult.after.success ? "✅ Pass" : "❌ Fail"}`);
        md.push("");
      }

      md.push("---");
      md.push("");
    }

    await writeFile(mdReportPath, md.join("\n"));
    console.log(`Migration markdown report written to: ${mdReportPath}`);

    // Final output
    console.log("\nMigration Complete!");
    console.log(`- Total Files: ${migrationReport.summary.totalFiles}`);
    console.log(`- Successfully Migrated: ${migrationReport.summary.successCount}`);
    console.log(`- Failed Migrations: ${migrationReport.summary.failCount}`);

    if (config.dryRun) {
      console.log("\nThis was a dry run. No files were modified.");
      console.log("To apply changes, run without the --dry-run flag.");
    }
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error in migration process:", err.message || err);
    process.exit(1);
  }
}

// Run the migration
migrateTests();
