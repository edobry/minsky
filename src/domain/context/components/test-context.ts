import * as fs from "fs/promises";
import * as path from "path";
import { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { log } from "../../../utils/logger";

export interface TestContextInputs extends ComponentInputs {
  framework: {
    name: "bun" | "jest" | "vitest" | "mocha" | "jasmine" | "unknown";
    version?: string;
    configFile?: string;
  };
  testFiles: {
    total: number;
    byType: Record<string, number>;
    patterns: string[];
    coverage?: {
      enabled: boolean;
      threshold?: number;
    };
  };
  testConfig: {
    rootDir?: string;
    testMatch?: string[];
    setupFiles?: string[];
    transformIgnorePatterns?: string[];
    collectCoverageFrom?: string[];
  };
  testScripts: Array<{
    name: string;
    command: string;
    description: string;
  }>;
  issues: {
    missingTests: string[];
    testPatterns: string[];
    recommendations: string[];
  };
}

/**
 * TestContextComponent - Bespoke Pattern
 *
 * Analyzes the testing setup, test files, coverage configuration,
 * and provides insights about test coverage and testing best practices.
 *
 * Features:
 * - Test framework detection (Bun, Jest, Vitest, etc.)
 * - Test file discovery and categorization
 * - Coverage configuration analysis
 * - Test pattern validation and recommendations
 * - Missing test file detection
 */
export const TestContextComponent: ContextComponent = {
  id: "test-context",
  name: "Test Context",
  description:
    "Testing framework state, test files, coverage configuration, and test quality insights",

  async gatherInputs(context: ComponentInput): Promise<TestContextInputs> {
    const { workspacePath, userPrompt } = context;

    try {
      // Detect test framework
      const framework = await detectTestFramework(workspacePath);

      // Discover test files
      const testFiles = await discoverTestFiles(workspacePath);

      // Load test configuration
      const testConfig = await loadTestConfig(workspacePath, framework.name);

      // Find test scripts
      const testScripts = await findTestScripts(workspacePath);

      // Analyze test issues and recommendations
      const issues = await analyzeTestIssues(workspacePath, testFiles, userPrompt);

      return {
        framework,
        testFiles,
        testConfig,
        testScripts,
        issues,
      };
    } catch (error) {
      log.error("Error gathering test context inputs:", error);
      return {
        framework: { name: "unknown" },
        testFiles: { total: 0, byType: {}, patterns: [] },
        testConfig: {},
        testScripts: [],
        issues: {
          missingTests: [],
          testPatterns: [],
          recommendations: ["Unable to analyze test setup"],
        },
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const { framework, testFiles, testConfig, testScripts, issues } = inputs as TestContextInputs;
    const { userPrompt } = context;

    const sections = ["## Test Context"];

    // Framework information
    sections.push(
      "",
      "### Test Framework",
      `**Framework**: ${framework.name}${framework.version ? ` v${framework.version}` : ""}`,
      ""
    );

    if (framework.configFile) {
      sections.push(`**Config File**: ${framework.configFile}`, "");
    }

    // Test files overview
    sections.push("### Test Files", `**Total Test Files**: ${testFiles.total}`, "");

    if (Object.keys(testFiles.byType).length > 0) {
      sections.push("**Test File Types**:");
      Object.entries(testFiles.byType).forEach(([type, count]) => {
        sections.push(`- ${type}: ${count} files`);
      });
      sections.push("");
    }

    if (testFiles.patterns.length > 0) {
      sections.push(
        "**Test Patterns**:",
        ...testFiles.patterns.map((pattern) => `- \`${pattern}\``),
        ""
      );
    }

    // Coverage information
    if (testFiles.coverage) {
      sections.push("### Coverage Configuration");
      sections.push(`**Coverage Enabled**: ${testFiles.coverage.enabled ? "✅ Yes" : "❌ No"}`);

      if (testFiles.coverage.threshold) {
        sections.push(`**Coverage Threshold**: ${testFiles.coverage.threshold}%`);
      }
      sections.push("");
    }

    // Test scripts
    if (testScripts.length > 0) {
      sections.push("### Test Scripts");

      // Filter scripts based on user prompt if provided
      const relevantScripts = userPrompt
        ? testScripts.filter((script) => isScriptRelevantToPrompt(script, userPrompt))
        : testScripts;

      if (relevantScripts.length > 0) {
        if (userPrompt && relevantScripts.length < testScripts.length) {
          sections.push(`*Scripts relevant to "${userPrompt}":*`, "");
        }

        relevantScripts.forEach((script) => {
          sections.push(`**${script.name}**: \`${script.command}\``);
          if (script.description) {
            sections.push(`  ${script.description}`);
          }
        });
        sections.push("");
      }
    }

    // Test configuration details (if user is interested in config)
    if (userPrompt?.toLowerCase().includes("config") && Object.keys(testConfig).length > 0) {
      sections.push("### Test Configuration");

      if (testConfig.rootDir) {
        sections.push(`**Root Directory**: ${testConfig.rootDir}`);
      }

      if (testConfig.testMatch) {
        sections.push("**Test Match Patterns**:");
        testConfig.testMatch.forEach((pattern) => {
          sections.push(`- \`${pattern}\``);
        });
      }

      if (testConfig.setupFiles) {
        sections.push("**Setup Files**:");
        testConfig.setupFiles.forEach((file) => {
          sections.push(`- \`${file}\``);
        });
      }
      sections.push("");
    }

    // Issues and recommendations
    if (issues.missingTests.length > 0) {
      sections.push(
        "### Missing Tests",
        `⚠️  **${issues.missingTests.length} files without corresponding tests**:`,
        ...issues.missingTests.slice(0, 5).map((file) => `- ${file}`),
        ""
      );

      if (issues.missingTests.length > 5) {
        sections.push(`*... and ${issues.missingTests.length - 5} more files*`, "");
      }
    }

    if (issues.testPatterns.length > 0) {
      sections.push(
        "### Test Pattern Issues",
        ...issues.testPatterns.map((issue) => `⚠️  ${issue}`),
        ""
      );
    }

    if (issues.recommendations.length > 0) {
      sections.push("### Recommendations", ...issues.recommendations.map((rec) => `- ${rec}`), "");
    }

    // Add context-specific guidance
    if (userPrompt) {
      const guidance = generateTestingGuidance(userPrompt, framework, testFiles, issues);
      if (guidance.length > 0) {
        sections.push(`### Testing Guidance for "${userPrompt}"`, ...guidance, "");
      }
    }

    // Test quality score
    const qualityScore = calculateTestQualityScore(testFiles, issues);
    sections.push(
      "### Test Quality Score",
      `**Overall Score**: ${qualityScore}/100`,
      `**Status**: ${getQualityStatus(qualityScore)}`
    );

    return {
      id: this.id,
      name: this.name,
      content: sections.join("\n"),
      metadata: {
        framework: framework.name,
        totalTests: testFiles.total,
        qualityScore,
        hasCoverage: testFiles.coverage?.enabled || false,
        missingTests: issues.missingTests.length,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};

async function detectTestFramework(workspacePath: string): Promise<TestContextInputs["framework"]> {
  try {
    // Check package.json for test dependencies
    const packagePath = path.join(workspacePath, "package.json");
    const packageContent = await fs.readFile(packagePath, "utf-8");
    const packageJson = JSON.parse(packageContent);

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    // Check for Bun test (native)
    if (packageJson.scripts?.test?.includes("bun test")) {
      return { name: "bun", version: process.versions.bun };
    }

    // Check for Jest
    if (allDeps.jest) {
      const configFile = await findConfigFile(workspacePath, [
        "jest.config.js",
        "jest.config.ts",
        "jest.config.json",
      ]);
      return {
        name: "jest",
        version: allDeps.jest,
        configFile: configFile ? path.basename(configFile) : undefined,
      };
    }

    // Check for Vitest
    if (allDeps.vitest) {
      const configFile = await findConfigFile(workspacePath, [
        "vitest.config.js",
        "vitest.config.ts",
        "vite.config.js",
        "vite.config.ts",
      ]);
      return {
        name: "vitest",
        version: allDeps.vitest,
        configFile: configFile ? path.basename(configFile) : undefined,
      };
    }

    // Check for Mocha
    if (allDeps.mocha) {
      const configFile = await findConfigFile(workspacePath, [
        ".mocharc.js",
        ".mocharc.json",
        "mocha.opts",
      ]);
      return {
        name: "mocha",
        version: allDeps.mocha,
        configFile: configFile ? path.basename(configFile) : undefined,
      };
    }

    // Check for Jasmine
    if (allDeps.jasmine) {
      return { name: "jasmine", version: allDeps.jasmine };
    }

    return { name: "unknown" };
  } catch (error) {
    return { name: "unknown" };
  }
}

async function findConfigFile(
  workspacePath: string,
  configNames: string[]
): Promise<string | undefined> {
  for (const configName of configNames) {
    try {
      const configPath = path.join(workspacePath, configName);
      await fs.access(configPath);
      return configPath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return undefined;
}

async function discoverTestFiles(workspacePath: string): Promise<TestContextInputs["testFiles"]> {
  const testFiles: TestContextInputs["testFiles"] = {
    total: 0,
    byType: {},
    patterns: [],
  };

  try {
    const files = await findTestFilesRecursively(workspacePath);
    testFiles.total = files.length;

    // Categorize by type
    files.forEach((file) => {
      const ext = path.extname(file);
      const type = getTestFileType(file);
      testFiles.byType[type] = (testFiles.byType[type] || 0) + 1;
    });

    // Detect common test patterns
    testFiles.patterns = detectTestPatterns(files);

    // Check for coverage configuration
    testFiles.coverage = await detectCoverageConfig(workspacePath);
  } catch (error) {
    log.warn("Error discovering test files:", error);
  }

  return testFiles;
}

async function findTestFilesRecursively(dir: string): Promise<string[]> {
  const testFiles: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules and other irrelevant directories
          if (!["node_modules", ".git", "dist", "build", ".next"].includes(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile() && isTestFile(entry.name)) {
          testFiles.push(fullPath);
        }
      }
    } catch (error) {
      // Directory not accessible, skip
    }
  }

  await walk(dir);
  return testFiles;
}

function isTestFile(fileName: string): boolean {
  const testPatterns = [
    /\.test\.(ts|js|tsx|jsx)$/,
    /\.spec\.(ts|js|tsx|jsx)$/,
    /__tests__.*\.(ts|js|tsx|jsx)$/,
    /__test__.*\.(ts|js|tsx|jsx)$/,
  ];

  return testPatterns.some((pattern) => pattern.test(fileName));
}

function getTestFileType(filePath: string): string {
  const fileName = path.basename(filePath);

  if (fileName.includes(".test.")) return "unit tests";
  if (fileName.includes(".spec.")) return "spec tests";
  if (fileName.includes("integration")) return "integration tests";
  if (fileName.includes("e2e") || fileName.includes("end-to-end")) return "e2e tests";
  if (filePath.includes("__tests__")) return "test suites";

  return "test files";
}

function detectTestPatterns(testFiles: string[]): string[] {
  const patterns = new Set<string>();

  testFiles.forEach((file) => {
    const fileName = path.basename(file);

    if (fileName.includes(".test.")) patterns.add("*.test.*");
    if (fileName.includes(".spec.")) patterns.add("*.spec.*");
    if (file.includes("__tests__")) patterns.add("**/__tests__/**");
    if (file.includes("/test/")) patterns.add("**/test/**");
    if (file.includes("/tests/")) patterns.add("**/tests/**");
  });

  return Array.from(patterns);
}

async function detectCoverageConfig(
  workspacePath: string
): Promise<TestContextInputs["testFiles"]["coverage"]> {
  try {
    // Check package.json for coverage scripts
    const packagePath = path.join(workspacePath, "package.json");
    const packageContent = await fs.readFile(packagePath, "utf-8");
    const packageJson = JSON.parse(packageContent);

    const hasTestCoverage =
      packageJson.scripts?.["test:coverage"] ||
      Object.values(packageJson.scripts || {}).some(
        (script: any) => script.includes("--coverage") || script.includes("--collect-coverage")
      );

    return {
      enabled: !!hasTestCoverage,
      threshold: undefined, // Would need to parse config files for this
    };
  } catch (error) {
    return { enabled: false };
  }
}

async function loadTestConfig(
  workspacePath: string,
  framework: string
): Promise<TestContextInputs["testConfig"]> {
  const config: TestContextInputs["testConfig"] = {};

  try {
    if (framework === "jest") {
      // Try to find and parse Jest config
      const configFile = await findConfigFile(workspacePath, ["jest.config.js", "jest.config.ts"]);
      if (configFile) {
        // In a real implementation, we'd parse the config file
        config.rootDir = path.dirname(configFile);
      }
    } else if (framework === "vitest") {
      // Try to find Vitest config
      const configFile = await findConfigFile(workspacePath, [
        "vitest.config.js",
        "vitest.config.ts",
      ]);
      if (configFile) {
        config.rootDir = path.dirname(configFile);
      }
    }
  } catch (error) {
    // Config parsing failed, use defaults
  }

  return config;
}

async function findTestScripts(workspacePath: string): Promise<TestContextInputs["testScripts"]> {
  try {
    const packagePath = path.join(workspacePath, "package.json");
    const packageContent = await fs.readFile(packagePath, "utf-8");
    const packageJson = JSON.parse(packageContent);

    const scripts: TestContextInputs["testScripts"] = [];

    Object.entries(packageJson.scripts || {}).forEach(([name, command]) => {
      if (isTestScript(name, command as string)) {
        scripts.push({
          name,
          command: command as string,
          description: getScriptDescription(name, command as string),
        });
      }
    });

    return scripts;
  } catch (error) {
    return [];
  }
}

function isTestScript(name: string, command: string): boolean {
  const testKeywords = ["test", "spec", "coverage", "lint:tests"];
  return testKeywords.some((keyword) => name.includes(keyword) || command.includes(keyword));
}

function getScriptDescription(name: string, command: string): string {
  if (name.includes("test:watch")) return "Run tests in watch mode";
  if (name.includes("test:coverage")) return "Run tests with coverage reporting";
  if (name.includes("test:debug")) return "Run tests in debug mode";
  if (name === "test") return "Run all tests";
  if (name.includes("lint:tests")) return "Lint test files";
  if (command.includes("--watch")) return "Watch mode enabled";
  if (command.includes("--coverage")) return "Includes coverage collection";
  return "";
}

async function analyzeTestIssues(
  workspacePath: string,
  testFiles: TestContextInputs["testFiles"],
  userPrompt?: string
): Promise<TestContextInputs["issues"]> {
  const issues: TestContextInputs["issues"] = {
    missingTests: [],
    testPatterns: [],
    recommendations: [],
  };

  try {
    // Find source files that might need tests
    const sourceFiles = await findSourceFiles(workspacePath);
    const testFileNames = new Set(
      (await findTestFilesRecursively(workspacePath)).map((f) => path.basename(f))
    );

    // Check for missing tests
    for (const sourceFile of sourceFiles) {
      const baseName = path.basename(sourceFile, path.extname(sourceFile));
      const hasTest =
        testFileNames.has(`${baseName}.test.ts`) ||
        testFileNames.has(`${baseName}.test.js`) ||
        testFileNames.has(`${baseName}.spec.ts`) ||
        testFileNames.has(`${baseName}.spec.js`);

      if (!hasTest) {
        issues.missingTests.push(sourceFile);
      }
    }

    // Generate recommendations
    if (testFiles.total === 0) {
      issues.recommendations.push("No test files found - consider adding tests for your project");
    } else if (testFiles.total < sourceFiles.length * 0.3) {
      issues.recommendations.push("Low test coverage - consider adding more tests");
    }

    if (!testFiles.coverage?.enabled) {
      issues.recommendations.push("Enable code coverage reporting to track test effectiveness");
    }

    if (testFiles.patterns.length === 0) {
      issues.recommendations.push("Establish consistent test file naming patterns");
    }

    // Add context-specific recommendations
    if (userPrompt) {
      const contextualRecs = generateTestRecommendations(userPrompt, testFiles);
      issues.recommendations.push(...contextualRecs);
    }
  } catch (error) {
    issues.recommendations.push("Unable to analyze test coverage comprehensively");
  }

  return issues;
}

async function findSourceFiles(workspacePath: string): Promise<string[]> {
  const sourceFiles: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (
            !["node_modules", ".git", "dist", "build", "__tests__", "test", "tests"].includes(
              entry.name
            )
          ) {
            await walk(fullPath);
          }
        } else if (entry.isFile() && isSourceFile(entry.name)) {
          sourceFiles.push(fullPath);
        }
      }
    } catch (error) {
      // Directory not accessible, skip
    }
  }

  await walk(path.join(workspacePath, "src")); // Focus on src directory
  return sourceFiles;
}

function isSourceFile(fileName: string): boolean {
  return /\.(ts|js|tsx|jsx)$/.test(fileName) && !isTestFile(fileName);
}

function isScriptRelevantToPrompt(
  script: TestContextInputs["testScripts"][0],
  prompt: string
): boolean {
  const promptLower = prompt.toLowerCase();
  const scriptText = `${script.name} ${script.command} ${script.description}`.toLowerCase();

  return (
    scriptText.includes(promptLower) ||
    (promptLower.includes("coverage") && scriptText.includes("coverage")) ||
    (promptLower.includes("watch") && scriptText.includes("watch")) ||
    (promptLower.includes("debug") && scriptText.includes("debug"))
  );
}

function generateTestingGuidance(
  prompt: string,
  framework: TestContextInputs["framework"],
  testFiles: TestContextInputs["testFiles"],
  issues: TestContextInputs["issues"]
): string[] {
  const guidance: string[] = [];
  const promptLower = prompt.toLowerCase();

  if (promptLower.includes("coverage") && !testFiles.coverage?.enabled) {
    guidance.push(
      "🎯 **Coverage Focus**: Enable test coverage reporting",
      `- Add coverage script: \`${framework.name} test --coverage\``,
      "- Set coverage thresholds in your test configuration",
      "- Use coverage reports to identify untested code paths"
    );
  }

  if (promptLower.includes("performance") && testFiles.total > 20) {
    guidance.push(
      "⚡ **Performance Focus**: Optimize test execution",
      "- Run tests in parallel when possible",
      "- Use test filtering to run only relevant tests during development",
      "- Consider test splitting for CI/CD environments"
    );
  }

  if (promptLower.includes("integration") && framework.name !== "unknown") {
    guidance.push(
      "🔗 **Integration Testing**: Best practices",
      "- Separate unit tests from integration tests",
      "- Use test containers or mocking for external dependencies",
      "- Consider end-to-end test automation for critical user flows"
    );
  }

  if (promptLower.includes("ci") || promptLower.includes("automation")) {
    guidance.push(
      "🤖 **CI/CD Integration**: Automated testing",
      "- Ensure tests run in CI/CD pipeline",
      "- Add test result reporting and coverage uploads",
      "- Consider parallel test execution for faster feedback"
    );
  }

  return guidance;
}

function generateTestRecommendations(
  prompt: string,
  testFiles: TestContextInputs["testFiles"]
): string[] {
  const recommendations: string[] = [];
  const promptLower = prompt.toLowerCase();

  if (promptLower.includes("unit") && testFiles.byType["unit tests"] === 0) {
    recommendations.push("Add unit tests to verify individual function/method behavior");
  }

  if (promptLower.includes("integration") && testFiles.byType["integration tests"] === 0) {
    recommendations.push("Consider adding integration tests for component interactions");
  }

  if (promptLower.includes("e2e") && testFiles.byType["e2e tests"] === 0) {
    recommendations.push("Add end-to-end tests for complete user workflows");
  }

  return recommendations;
}

function calculateTestQualityScore(
  testFiles: TestContextInputs["testFiles"],
  issues: TestContextInputs["issues"]
): number {
  let score = 50; // Base score

  // Add points for having tests
  if (testFiles.total > 0) score += 20;
  if (testFiles.total > 10) score += 10;
  if (testFiles.total > 25) score += 10;

  // Add points for coverage
  if (testFiles.coverage?.enabled) score += 15;

  // Add points for consistent patterns
  if (testFiles.patterns.length > 0) score += 10;

  // Deduct points for issues
  score -= Math.min(issues.missingTests.length * 2, 30);
  score -= issues.testPatterns.length * 5;

  return Math.max(0, Math.min(100, score));
}

function getQualityStatus(score: number): string {
  if (score >= 80) return "🟢 Excellent";
  if (score >= 60) return "🟡 Good";
  if (score >= 40) return "🟠 Needs Improvement";
  return "🔴 Poor";
}

export function createTestContextComponent(): ContextComponent {
  return TestContextComponent;
}
