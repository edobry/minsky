#!/usr/bin/env bun

/**
 * Test Analyzer Script
 *
 * This script analyzes test files in the codebase to categorize them by:
 * - Mocking patterns (mock functions, spies, module mocks)
 * - Test framework dependencies (e.g., Jest/Vitest vs Bun)
 * - Test setup and teardown patterns
 * - Assertion styles
 *
 * Usage:
 *   bun src/scripts/test-analyzer.ts [--output-file=<path>] [--target-dir=<dir>]
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { log } from "../utils/logger.js";

// Get current directory
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const baseDir = resolve(__dirname, "../..");

// Configuration
const config = {
  outputFile: "test-analysis-report.json",
  targetDir: "src",
  testFilePattern: /\.test\.ts$/,
};

// Parse command line arguments
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--output-file=")) {
    const value = arg.split("=")[1];
    if (value) config.outputFile = value;
  } else if (arg.startsWith("--target-dir=")) {
    const value = arg.split("=")[1];
    if (value) config.targetDir = value;
  }
}

// Category patterns to search for
const patterns = {
  // Mocking patterns
  mockPatterns: {
    jestMock: /jest\.fn\(/g,
    bunMock: /mock\.fn\(/g,
    customMock: /createMock\(/g,
    mockFunction: /mockFunction\(/g,
    mockModule: /jest\.mock\(|mock\.module\(|mockModule\(/g,
    spyOn: /jest\.spyOn\(|createSpyOn\(/g,
  },
  // Framework specific features
  frameworkFeatures: {
    jestDescribe: /describe\(/g,
    jestTest: /test\(/g,
    jestIt: /it\(/g,
    jestBeforeEach: /beforeEach\(/g,
    jestAfterEach: /afterEach\(/g,
    jestBeforeAll: /beforeAll\(/g,
    jestAfterAll: /afterAll\(/g,
    bunImport: /import.*from\s+['"]bun:test['"]/g,
    jestImport: /import.*from\s+['"]jest['"]/g,
    vitestImport: /import.*from\s+['"]vitest['"]/g,
  },
  // Assertion styles
  assertionStyles: {
    jestExpect: /expect\(/g,
    jestToBe: /\.toBe\(/g,
    jestToEqual: /\.toEqual\(/g,
    jestToStrictEqual: /\.toStrictEqual\(/g,
    jestToBeNull: /\.toBeNull\(/g,
    jestToBeDefined: /\.toBeDefined\(/g,
    jestToBeUndefined: /\.toBeUndefined\(/g,
    jestToHaveBeenCalled: /\.toHaveBeenCalled\(/g,
    jestToHaveBeenCalledWith: /\.toHaveBeenCalledWith\(/g,
    jestToContain: /\.toContain\(/g,
    jestToThrow: /\.toThrow\(/g,
    jestToMatch: /\.toMatch\(/g,
    jestRejects: /\.rejects\./g,
    jestResolves: /\.resolves\./g,
  },
  // Utility usage
  utilities: {
    testUtils: /test-utils/g,
    mocking: /mocking\.ts/g,
    factories: /factories\.ts/g,
    dependencies: /dependencies\.ts/g,
    withMockedDeps: /withMockedDeps\(/g,
    createTestDeps: /createTestDeps\(/g,
    createTestSuite: /createTestSuite\(/g,
    withCleanup: /withCleanup\(/g,
  },
};

interface TestFileAnalysis {
  _path: string;
  relativePath: string;
  size: number;
  counts: {
    mockPatterns: Record<string, number>;
    frameworkFeatures: Record<string, number>;
    assertionStyles: Record<string, number>;
    utilities: Record<string, number>;
  };
  imports: string[];
  mockDependencies: string[];
  classification: {
    mockingComplexity: "low" | "medium" | "high";
    frameworkDependency: "jest" | "vitest" | "bun" | "mixed" | "none";
    migrationDifficulty: "easy" | "medium" | "hard";
    testType: "unit" | "integration" | "e2e" | "unknown";
  };
  summary: string;
}

interface AnalysisReport {
  timestamp: string;
  testFilesCount: number;
  testFiles: TestFileAnalysis[];
  totals: {
    mockPatterns: Record<string, number>;
    frameworkFeatures: Record<string, number>;
    assertionStyles: Record<string, number>;
    utilities: Record<string, number>;
  };
  categoryCounts: {
    mockingComplexity: Record<string, number>;
    frameworkDependency: Record<string, number>;
    migrationDifficulty: Record<string, number>;
    testType: Record<string, number>;
  };
  topUtilities: { name: string; count: number }[];
  failingPatterns: { pattern: string; files: string[] }[];
}

/**
 * Find all test files in a directory recursively
 */
async function findTestFiles(_dir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(_currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(path);
      } else if (config.testFilePattern.test(entry.name)) {
        files.push(path);
      }
    }
  }

  await scan(dir);
  return files;
}

/**
 * Extract imports from a file
 */
function extractImports(_content: string): string[] {
  const importRegex = /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath) {
      imports.push(importPath);
    }
  }

  return imports;
}

/**
 * Extract mock dependencies from a file
 */
function extractMockDependencies(_content: string): string[] {
  const mockRegex = /(?:jest\.mock|mock\.module|mockModule)\(['"](.*?)['"]/g;
  const dependencies: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mockRegex.exec(content)) !== null) {
    const dependency = match[1];
    if (dependency) {
      dependencies.push(dependency);
    }
  }

  return dependencies;
}

/**
 * Analyze a single test file
 */
async function analyzeTestFile(_path: string): Promise<TestFileAnalysis> {
  const content = await readFile(path, "utf-8");
  const relativePath = relative(baseDir, path);
  const counts = {
    mockPatterns: {} as Record<string, number>,
    frameworkFeatures: {} as Record<string, number>,
    assertionStyles: {} as Record<string, number>,
    utilities: {} as Record<string, number>,
  };

  // Count pattern occurrences
  for (const [category, categoryPatterns] of Object.entries(patterns)) {
    for (const [name, pattern] of Object.entries(categoryPatterns)) {
      const matches = content.match(pattern) || [];
      const categoryKey = category as keyof typeof counts;
      counts[categoryKey][name] = matches.length;
    }
  }

  // Extract imports and mock dependencies
  const imports = extractImports(content);
  const mockDependencies = extractMockDependencies(content);

  // Calculate metrics for classification
  const totalMocks = Object.values(counts.mockPatterns).reduce((sum, count) => sum + count, 0);
  const usesJest =
    imports.some((_i: unknown) => i.includes("jest")) ||
    (counts.frameworkFeatures.jestImport !== undefined && counts.frameworkFeatures.jestImport > 0);
  const usesBun =
    imports.some((_i: unknown) => i.includes("bun:test")) ||
    (counts.frameworkFeatures.bunImport !== undefined && counts.frameworkFeatures.bunImport > 0);
  const usesVitest =
    imports.some((_i: unknown) => i.includes("vitest")) ||
    (counts.frameworkFeatures.vitestImport !== undefined &&
      counts.frameworkFeatures.vitestImport > 0);
  const usesCustomMocks =
    (counts.mockPatterns.customMock !== undefined && counts.mockPatterns.customMock > 0) ||
    (counts.mockPatterns.mockFunction !== undefined && counts.mockPatterns.mockFunction > 0);
  const usesMockModule =
    counts.mockPatterns.mockModule !== undefined && counts.mockPatterns.mockModule > 0;

  // Simple heuristic for integration vs. unit tests
  const isIntegration =
    relativePath.includes("integration") ||
    relativePath.includes("e2e") ||
    mockDependencies.length > 3;

  // Classify the test file
  const classification = {
    mockingComplexity:
      totalMocks <= 3
        ? "low"
        : ((totalMocks <= 10 ? "medium" : "high") as "low" | "medium" | "high"),
    frameworkDependency: usesBun
      ? "bun"
      : ((usesJest ? "jest" : usesVitest ? "vitest" : "none") as
          | "jest"
          | "vitest"
          | "bun"
          | "mixed"
          | "none"),
    migrationDifficulty: "medium" as "easy" | "medium" | "hard", // Default
    testType: isIntegration
      ? "integration"
      : ("unit" as "unit" | "integration" | "e2e" | "unknown"),
  };

  // Determine migration difficulty based on various factors
  if (usesCustomMocks && usesBun) {
    classification.migrationDifficulty = "easy";
  } else if (usesMockModule && (usesJest || usesVitest)) {
    classification.migrationDifficulty = "hard";
  } else if (totalMocks > 10) {
    classification.migrationDifficulty = "hard";
  } else if (totalMocks === 0) {
    classification.migrationDifficulty = "easy";
  }

  // Generate summary
  let summary = `${relativePath} - `;
  summary += `${classification.mockingComplexity} mocking complexity, `;
  summary += `${classification.testType} test, `;
  summary += `${classification.frameworkDependency} framework, `;
  summary += `${classification.migrationDifficulty} migration`;

  return {
    path,
    relativePath,
    size: content.length,
    counts,
    imports,
    mockDependencies,
    classification,
    summary,
  };
}

/**
 * Generate an analysis report from all test files
 */
async function generateReport(_testFiles: TestFileAnalysis[]): Promise<AnalysisReport> {
  const totals = {
    mockPatterns: {} as Record<string, number>,
    frameworkFeatures: {} as Record<string, number>,
    assertionStyles: {} as Record<string, number>,
    utilities: {} as Record<string, number>,
  };

  // Initialize totals
  for (const category of Object.keys(patterns)) {
    const categoryKey = category as keyof typeof totals;
    for (const pattern of Object.keys(patterns[categoryKey])) {
      totals[categoryKey][pattern] = 0;
    }
  }

  // Calculate totals
  for (const file of testFiles) {
    for (const category of Object.keys(patterns)) {
      const categoryKey = category as keyof typeof file.counts;
      for (const pattern of Object.keys(file.counts[categoryKey] || {})) {
        const value = file.counts[categoryKey]?.[pattern] || 0;
        if (totals[categoryKey]) {
          totals[categoryKey][pattern] = (totals[categoryKey][pattern] || 0) + value;
        }
      }
    }
  }

  // Calculate category counts
  const categoryCounts = {
    mockingComplexity: { low: 0, medium: 0, high: 0 },
    frameworkDependency: { jest: 0, vitest: 0, bun: 0, mixed: 0, none: 0 },
    migrationDifficulty: { easy: 0, medium: 0, hard: 0 },
    testType: { unit: 0, integration: 0, e2e: 0, unknown: 0 },
  };

  for (const file of testFiles) {
    categoryCounts.mockingComplexity[file.classification.mockingComplexity]++;
    categoryCounts.frameworkDependency[file.classification.frameworkDependency]++;
    categoryCounts.migrationDifficulty[file.classification.migrationDifficulty]++;
    categoryCounts.testType[file.classification.testType]++;
  }

  // Calculate top utilities
  const allUtilities = Object.keys(totals.utilities);
  const topUtilities = allUtilities
    .map((name) => ({ name, count: totals.utilities[name] || 0 }))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 10);

  // Identify failing patterns (good heuristic for what's failing in Bun)
  const failingPatterns: { pattern: string; files: string[] }[] = [
    { pattern: "jest.mock usage", files: [] },
    { pattern: "jest.spyOn usage", files: [] },
    { pattern: "beforeEach/afterEach without imports", files: [] },
    { pattern: "mock.fn not imported", files: [] },
  ];

  for (const file of testFiles) {
    // Check for jest.mock usage
    if (
      file.counts.mockPatterns.mockModule !== undefined &&
      file.counts.mockPatterns.mockModule > 0 &&
      !file.imports.some((_i: unknown) => i.includes("bun:test"))
    ) {
      failingPatterns[0]?.files?.push(file.relativePath);
    }

    // Check for jest.spyOn usage
    if (
      file.counts.mockPatterns.spyOn !== undefined &&
      file.counts.mockPatterns.spyOn > 0 &&
      !file.imports.some((_i: unknown) => i.includes("createSpyOn"))
    ) {
      failingPatterns[1]?.files?.push(file.relativePath);
    }

    // Check for beforeEach/afterEach without imports
    if (
      ((file.counts.frameworkFeatures.jestBeforeEach !== undefined &&
        file.counts.frameworkFeatures.jestBeforeEach > 0) ||
        (file.counts.frameworkFeatures.jestAfterEach !== undefined &&
          file.counts.frameworkFeatures.jestAfterEach > 0)) &&
      !file.imports.some((_i: unknown) => i.includes("bun:test"))
    ) {
      failingPatterns[2]?.files?.push(file.relativePath);
    }

    // Check for mock.fn usage without import
    if (
      file.counts.mockPatterns.bunMock !== undefined &&
      file.counts.mockPatterns.bunMock > 0 &&
      !file.imports.some((_i: unknown) => i.includes("bun:test"))
    ) {
      failingPatterns[3]?.files?.push(file.relativePath);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    testFilesCount: testFiles.length,
    testFiles,
    totals,
    categoryCounts,
    topUtilities,
    failingPatterns: failingPatterns.filter((pattern) => pattern.files.length > 0),
  };
}

/**
 * Generate a markdown summary from the analysis report
 */
async function generateMarkdownSummary(_report: AnalysisReport, outputPath: string): Promise<void> {
  const md = [
    "# Test Analysis Report",
    "",
    `Generated: ${new Date(report.timestamp).toLocaleString()}`,
    "",
    `Total test files analyzed: **${report.testFilesCount}**`,
    "",
    "## Test Classification Summary",
    "",
    "### By Mocking Complexity",
    "",
    "| Complexity | Count | Percentage |",
    "|-----------|-------|------------|",
  ];

  // Mocking complexity table
  for (const [complexity, count] of Object.entries(report.categoryCounts.mockingComplexity)) {
    const percentage = ((count / report.testFilesCount) * 100).toFixed(1);
    md.push(`| ${complexity} | ${count} | ${percentage}% |`);
  }

  md.push(
    "",
    "### By Framework Dependency",
    "",
    "| Framework | Count | Percentage |",
    "|-----------|-------|------------|"
  );

  // Framework dependency table
  for (const [framework, count] of Object.entries(report.categoryCounts.frameworkDependency)) {
    const percentage = ((count / report.testFilesCount) * 100).toFixed(1);
    md.push(`| ${framework} | ${count} | ${percentage}% |`);
  }

  md.push(
    "",
    "### By Migration Difficulty",
    "",
    "| Difficulty | Count | Percentage |",
    "|-----------|-------|------------|"
  );

  // Migration difficulty table
  for (const [difficulty, count] of Object.entries(report.categoryCounts.migrationDifficulty)) {
    const percentage = ((count / report.testFilesCount) * 100).toFixed(1);
    md.push(`| ${difficulty} | ${count} | ${percentage}% |`);
  }

  md.push(
    "",
    "### By Test Type",
    "",
    "| Type | Count | Percentage |",
    "|-----------|-------|------------|"
  );

  // Test type table
  for (const [type, count] of Object.entries(report.categoryCounts.testType)) {
    const percentage = ((count / report.testFilesCount) * 100).toFixed(1);
    md.push(`| ${type} | ${count} | ${percentage}% |`);
  }

  md.push(
    "",
    "## Top Test Utilities Usage",
    "",
    "| Utility | Usage Count |",
    "|---------|-------------|"
  );

  // Top utilities table
  for (const { name, count } of report.topUtilities) {
    if (count > 0) {
      md.push(`| ${name} | ${count} |`);
    }
  }

  md.push("", "## Common Failing Patterns", "");

  // Failing patterns
  for (const { pattern, files } of report.failingPatterns) {
    md.push(`### ${pattern} (${files.length} files)`);
    md.push("");
    for (const file of files.slice(0, 10)) {
      // Show up to 10 files per pattern
      md.push(`- \`${file}\``);
    }
    if (files.length > 10) {
      md.push(`- ... and ${files.length - 10} more files`);
    }
    md.push("");
  }

  md.push("", "## Files by Migration Difficulty", "");

  // Files by migration difficulty
  const difficultyLevels: ("easy" | "medium" | "hard")[] = ["hard", "medium", "easy"];
  for (const difficulty of difficultyLevels) {
    const filesWithDifficulty = report.testFiles.filter(
      (file) => file.classification.migrationDifficulty === difficulty
    );

    md.push(
      `### ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} (${filesWithDifficulty.length} files)`
    );
    md.push("");

    for (const file of filesWithDifficulty.slice(0, 15)) {
      // Show up to 15 files per difficulty
      md.push(
        `- \`${file.relativePath}\` - ${file.classification.mockingComplexity} mocking, ${file.classification.testType} test`
      );
    }
    if (filesWithDifficulty.length > 15) {
      md.push(`- ... and ${filesWithDifficulty.length - 15} more files`);
    }
    md.push("");
  }

  md.push(
    "",
    "## Migration Strategy Recommendations",
    "",
    "### Recommended Approach",
    "",
    "1. **Start with \"easy\" tests** - First migrate tests with low mocking complexity",
    "2. **Create utility adapters** - Develop adapters for common Jest patterns",
    "3. **Standardize mocking utilities** - Enhance current mocking utilities",
    "4. **Tackle integration tests last** - These often have the most complex mocking needs",
    "",
    "### Priority Tests for Migration",
    ""
  );

  // Priority tests
  const priorityTests = report.testFiles
    .filter((file) => file.classification.migrationDifficulty === "easy")
    .sort((a, b) => {
      // Sort by test type (unit first), then by complexity (low first)
      if (a.classification.testType !== b.classification.testType) {
        return a.classification.testType === "unit" ? -1 : 1;
      }
      const aMockModule = a.counts.mockPatterns.mockModule || 0;
      const bMockModule = b.counts.mockPatterns.mockModule || 0;
      return aMockModule - bMockModule;
    })
    .slice(0, 10);

  for (const file of priorityTests) {
    md.push(`- \`${file.relativePath}\``);
  }

  await writeFile(outputPath, md.join("\n"));
}

/**
 * Main function
 */
async function main() {
  try {
    log.cli("Test Analyzer Script");
    log.cli("-------------------");
    log.cli(`Analyzing tests in: ${config.targetDir}`);

    // Find all test files
    const targetDir = resolve(baseDir, config.targetDir);
    const testFiles = await findTestFiles(targetDir);
    log.cli(`Found ${testFiles.length} test files`);

    // Analyze each test file
    const analyses: TestFileAnalysis[] = [];
    for (const [index, file] of testFiles.entries()) {
      process.stdout.write(
        `Analyzing file ${index + 1}/${testFiles.length}: ${relative(baseDir, file)}\r`
      );
      const analysis = await analyzeTestFile(file);
      analyses.push(analysis);
    }
    log.cli("\nAnalysis complete");

    // Generate the report
    const report = await generateReport(analyses);

    // Create output directory if needed
    const outputDir = resolve(baseDir, "test-analysis");
    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true });
    }

    // Write JSON report
    const jsonOutputPath = resolve(outputDir, config.outputFile);
    await writeFile(jsonOutputPath, JSON.stringify(report, null, 2));
    log.cli(`Report written to: ${jsonOutputPath}`);

    // Write Markdown summary
    const mdOutputPath = resolve(outputDir, config.outputFile.replace(/\.json$/, ".md"));
    await generateMarkdownSummary(report, mdOutputPath);
    log.cli(`Summary written to: ${mdOutputPath}`);

    // Output quick stats
    log.cli("\nQuick Stats:");
    log.cli(`- Total test files: ${report.testFilesCount}`);
    log.cli(
      "- Files by difficulty: " +
        `Easy: ${report.categoryCounts.migrationDifficulty.easy}, ` +
        `Medium: ${report.categoryCounts.migrationDifficulty.medium}, ` +
        `Hard: ${report.categoryCounts.migrationDifficulty.hard}`
    );
    log.cli(
      "- Framework dependencies: " +
        `Bun: ${report.categoryCounts.frameworkDependency.bun}, ` +
        `Jest: ${report.categoryCounts.frameworkDependency.jest}, ` +
        `Vitest: ${report.categoryCounts.frameworkDependency.vitest}, ` +
        `None: ${report.categoryCounts.frameworkDependency.none}`
    );
  } catch {
    log.cliError("Error running test analyzer:", error);
    process.exit(1);
  }
}

// Run the script
main();
