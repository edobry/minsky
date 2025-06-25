#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

function findTsFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry)) {
          walk(fullPath);
        }
      } else if (extname(entry) === ".ts") {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function fixRemainingParams(content: string): { content: string; changeCount: number } {
  let newContent = content;
  let totalChanges = 0;

  // Function parameter patterns
  const functionPatterns = [
    // getMockModule function
    {
      pattern:
        /export function getMockModule\(__modulePath: string\): unknown {\s*return mockedModules\.get\(modulePath\);/g,
      replacement:
        "export function getMockModule(modulePath: string): unknown {\n  return mockedModules.get(modulePath);",
    },
    // registerAsymmetricMatchers
    {
      pattern:
        /export function registerAsymmetricMatchers\(__expectObj: unknown\): void {\s*\/\/ Add each matcher to the expect object\s*for \(const \[key, value\] of Object\.entries\(asymmetricMatchers\)\) {\s*if \(!\(key in expectObj\)\) {\s*expectObj\[key\] = value;/g,
      replacement:
        "export function registerAsymmetricMatchers(expectObj: unknown): void {\n  // Add each matcher to the expect object\n  for (const [key, value] of Object.entries(asymmetricMatchers)) {\n    if (!(key in expectObj)) {\n      expectObj[key] = value;",
    },
    // isAsymmetricMatcher
    {
      pattern:
        /export function isAsymmetricMatcher\(__obj: unknown\): obj is AsymmetricMatcher {\s*return obj !== null/g,
      replacement:
        "export function isAsymmetricMatcher(obj: unknown): obj is AsymmetricMatcher {\n  return obj !== null",
    },
    // createTaskTestDeps
    {
      pattern:
        /export function createTaskTestDeps\(__overrides: Partial<TaskDependencies> = {}\): TaskDependencies {([^}]*?)\.\.\.overrides([^}]*?)}/g,
      replacement:
        "export function createTaskTestDeps(overrides: Partial<TaskDependencies> = {}): TaskDependencies {$1...overrides$2}",
    },
    // createGitTestDeps
    {
      pattern:
        /export function createGitTestDeps\(__overrides: Partial<GitDependencies> = {}\): GitDependencies {([^}]*?)\.\.\.overrides([^}]*?)}/g,
      replacement:
        "export function createGitTestDeps(overrides: Partial<GitDependencies> = {}): GitDependencies {$1...overrides$2}",
    },
    // createDeepTestDeps
    {
      pattern:
        /export function createDeepTestDeps\(__partialDeps: Partial<DomainDependencies>\): DomainDependencies {([^}]*?)partialDeps([^}]*?)}/g,
      replacement:
        "export function createDeepTestDeps(partialDeps: Partial<DomainDependencies>): DomainDependencies {$1partialDeps$2}",
    },
    // createMockFileSystem
    {
      pattern:
        /export function createMockFileSystem\(__initialFiles: Record<string, string> = {}\) {([^}]*?)initialFiles([^}]*?)}/g,
      replacement:
        "export function createMockFileSystem(initialFiles: Record<string, string> = {}) {$1initialFiles$2}",
    },
    // registerMcpCommands
    {
      pattern:
        /export function registerMcpCommands\(__mcpServer: FastMcpServer\) {([^}]*?)mcpServer([^}]*?)}/g,
      replacement: "export function registerMcpCommands(mcpServer: FastMcpServer) {$1mcpServer$2}",
    },
    // Test analyzer functions
    {
      pattern:
        /async function findTestFiles\(__dir: string\): Promise<string\[\]> {([^}]*?)dir([^}]*?)}/g,
      replacement: "async function findTestFiles(dir: string): Promise<string[]> {$1dir$2}",
    },
    {
      pattern:
        /async function generateReport\(__testFiles: TestFileAnalysis\[\]\): Promise<AnalysisReport> {([^}]*?)testFiles([^}]*?)}/g,
      replacement:
        "async function generateReport(testFiles: TestFileAnalysis[]): Promise<AnalysisReport> {$1testFiles$2}",
    },
    {
      pattern:
        /async function generateMarkdownSummary\(__report: AnalysisReport, outputPath: string\): Promise<void> {([^}]*?)report([^}]*?)}/g,
      replacement:
        "async function generateMarkdownSummary(report: AnalysisReport, outputPath: string): Promise<void> {$1report$2}",
    },
  ];

  // Arrow function patterns in mock functions
  const arrowPatterns = [
    // Generic _path patterns in mocking functions
    {
      pattern: /createMock\((\(?)_path: unknown\) => {([^}]*?)path([^}]*?)}\)/g,
      replacement: "createMock($1path: unknown) => {$2path$3})",
    },
    {
      pattern: /createMock\(async \((_?)path: unknown\) => {([^}]*?)path([^}]*?)}\)/g,
      replacement: "createMock(async (path: unknown) => {$2path$3})",
    },
    // Multiple _command patterns in git test file
    {
      pattern: /createMock\(async \(_command: unknown\) => {([^}]*?)}\)/g,
      replacement: "createMock(async (command: unknown) => {$1})",
    },
    {
      pattern:
        /\.mockImplementation\(async \((_workdir, )?_command\) => {([^}]*?)command([^}]*?)}\)/g,
      replacement: ".mockImplementation(async ($1command) => {$2command$3})",
    },
    // Other common patterns
    {
      pattern: /createMock\(\(_workdir, _command\) => {([^}]*?)command([^}]*?)}\)/g,
      replacement: "createMock((_workdir, command) => {$1command$2})",
    },
    {
      pattern: /createMock\(\(_name\) =>([^}]*?)name([^}]*?)\)/g,
      replacement: "createMock((name) =>$1name$2)",
    },
    {
      pattern: /createMock\(\(_sessionName: unknown\) =>([^}]*?)sessionName([^}]*?)\)/g,
      replacement: "createMock((sessionName: unknown) =>$1sessionName$2)",
    },
    {
      pattern: /createMockFn\(async \(_sessionName: unknown\) => {([^}]*?)sessionName([^}]*?)}\)/g,
      replacement: "createMockFn(async (sessionName: unknown) => {$1sessionName$2})",
    },
    {
      pattern: /createMockFn\(async \(_options\) => {([^}]*?)options([^}]*?)}\)/g,
      replacement: "createMockFn(async (options) => {$1options$2})",
    },
    // Mock function implementation pattern
    {
      pattern:
        /mockImplementation\(_fn: \(\.\.\.args: TArgs\) => TReturn\): CompatMockFunction<TReturn, TArgs> {([^}]*?)fn([^}]*?)}/g,
      replacement:
        "mockImplementation(fn: (...args: TArgs) => TReturn): CompatMockFunction<TReturn, TArgs> {$1fn$2}",
    },
    // testFn pattern
    {
      pattern: /testFn: \(_deps: unknown\) => R([^}]*?)deps([^}]*?)}/g,
      replacement: "testFn: (deps: unknown) => R$1deps$2}",
    },
    // _payload pattern
    {
      pattern: /async \(_payload: unknown\) => {([^}]*?)payload([^}]*?)}/g,
      replacement: "async (payload: unknown) => {$1payload$2}",
    },
  ];

  // Special cases for multiline patterns
  const multilinePatterns = [
    // git.test.ts specific patterns
    {
      pattern:
        /spyOn\(GitService\.prototype, "execInRepository"\)\.mockImplementation\(async \(_workdir, _command\) => {/g,
      replacement:
        "spyOn(GitService.prototype, \"execInRepository\").mockImplementation(async (_workdir, command) => {",
    },
  ];

  [...functionPatterns, ...arrowPatterns, ...multilinePatterns].forEach(
    ({ pattern, replacement }) => {
      const before = newContent;
      newContent = newContent.replace(pattern, replacement);
      const beforeMatches = (before.match(pattern) || []).length;
      const afterMatches = (newContent.match(pattern) || []).length;
      const changes = beforeMatches - afterMatches;
      totalChanges += changes;
    }
  );

  return {
    content: newContent,
    changeCount: totalChanges,
  };
}

async function main() {
  const files = findTsFiles("src");
  console.log(`Found ${files.length} TypeScript files to process`);

  let totalFiles = 0;
  let totalChanges = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8").toString();
      const { content: newContent, changeCount } = fixRemainingParams(content);

      if (changeCount > 0) {
        writeFileSync(file, newContent, "utf8");
        console.log(`✅ Fixed ${changeCount} parameter issues in ${file}`);
        totalFiles++;
        totalChanges += changeCount;
      }
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error);
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   Files modified: ${totalFiles}`);
  console.log(`   Total fixes: ${totalChanges}`);
}

if (import.meta.main) {
  await main();
}
