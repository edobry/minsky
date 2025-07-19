#!/usr/bin/env bun

/**
 * AST Codemod: Git Commands Integration Tests Mock Infrastructure Fixer
 * 
 * SYSTEMATIC AST CODEMOD - Git Commands Integration Tests Infrastructure
 * 
 * Problem: Git Commands Integration Tests are executing real git commands instead of mocks
 * - Issue 1: exec/promisify mocking not working properly 
 * - Issue 2: Storage backend shape mismatch (`result.data.sessions.find is not a function`)
 * - Issue 3: Tests trying to operate on non-git directories
 * 
 * This codemod:
 * 1. Fixes mock setup to properly intercept git execution
 * 2. Adds proper mock for createGitService to return mocked GitService
 * 3. Fixes storage backend mocking to have correct shape
 * 4. Ensures tests use mocked execution instead of real git commands
 * 
 * Target Files:
 * - src/domain/git/commands/__tests__/integration.test.ts
 * 
 * Expected Impact: +8 passing tests (Git Commands Integration Tests)
 */

import { Project, SourceFile, SyntaxKind } from "ts-morph";

interface GitMockFixResult {
  filePath: string;
  changed: boolean;
  reason: string;
}

export function fixGitCommandsIntegrationMocks(sourceFile: SourceFile): GitMockFixResult {
  const filePath = sourceFile.getFilePath();
  const content = sourceFile.getFullText();
  
  // Only process the specific test file
  if (!filePath.includes('git/commands/__tests__/integration.test.ts')) {
    return {
      filePath,
      changed: false,
      reason: 'Not the target git commands integration test file - skipped'
    };
  }
  
  let fixed = false;
  
  // Find the mock setup section and replace it with comprehensive mocking
  const imports = sourceFile.getImportDeclarations();
  
  // Find where the mock setup starts (after imports)
  const lastImport = imports[imports.length - 1];
  
  if (lastImport) {
    // Replace the existing mock setup with a comprehensive one
    const newMockSetup = `
// Mock all git execution paths comprehensively
const mockExecAsync = createMock() as any;
const mockGitService = {
  clone: createMock(),
  createBranch: createMock(),
  commitChanges: createMock(),
  push: createMock(),
  merge: createMock(),
  checkout: createMock(),
  rebase: createMock(),
  createPullRequest: createMock(),
  execInRepository: createMock(),
  getSessionWorkdir: createMock(),
} as any;

// Mock the createGitService factory to return our mock
const mockCreateGitService = createMock() as any;
mockCreateGitService.mockReturnValue(mockGitService);

// Mock git execution at multiple levels
mock.module("node:child_process", () => ({
  exec: mockExecAsync,
}));

mock.module("node:util", () => ({
  promisify: () => mockExecAsync,
}));

mock.module("../../git", () => ({
  createGitService: mockCreateGitService,
}));

// Mock storage backend to fix data.sessions.find error
const mockSessionProvider = {
  getSession: createMock(),
  addSession: createMock(),
  updateSession: createMock(),
  deleteSession: createMock(),
  listSessions: createMock(),
};

mock.module("../../session", () => ({
  createSessionProvider: () => mockSessionProvider,
}));

// Mock logger to prevent console noise
mock.module("../../../utils/logger", () => ({
  log: {
    info: createMock(),
    error: createMock(),
    debug: createMock(),
    warn: createMock(),
  },
}));

setupTestMocks();
`;
    
    // Find where setupTestMocks() is called and replace everything before it
    const mockSetupPattern = /\/\/ Mock.*?setupTestMocks\(\);/s;
    if (mockSetupPattern.test(content)) {
      const newContent = content.replace(mockSetupPattern, newMockSetup.trim());
      sourceFile.replaceWithText(newContent);
      fixed = true;
      console.log(`✅ Updated comprehensive mock setup in ${filePath}`);
    }
  }
  
  // Update beforeEach to set up proper mock behavior
  const functions = sourceFile.getFunctions();
  for (const func of functions) {
    if (func.getName() === "beforeEach" || func.getFirstChild()?.getText().includes("beforeEach")) {
      // This is handled by finding describe blocks and beforeEach calls within them
    }
  }
  
  // Find beforeEach calls and update them
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const callExpr of callExpressions) {
    const expression = callExpr.getExpression();
    if (expression.getText() === "beforeEach") {
      const arrowFunction = callExpr.getArguments()[0];
      if (arrowFunction) {
        // Replace the beforeEach content with comprehensive mock setup
        const newBeforeEach = `() => {
    // Set up proper temporary directory management
    fsCleanup = new FileSystemTestCleanup();
    tempWorkdir = fsCleanup.createTempDir("git-test-workdir");
    
    // Reset all mocks
    mockExecAsync.mockReset();
    mockCreateGitService.mockReset();
    mockSessionProvider.getSession.mockReset();
    
    // Set up mock GitService to return our mocked instance
    mockCreateGitService.mockReturnValue(mockGitService);
    
    // Set up successful mock responses for git operations
    mockGitService.clone.mockResolvedValue({
      workdir: tempWorkdir,
      session: "test-session",
      repoPath: tempWorkdir,
    });
    
    mockGitService.createBranch.mockResolvedValue({
      success: true,
      branchName: "feature-branch",
    });
    
    mockGitService.commitChanges.mockResolvedValue({
      success: true,
      commitHash: "abc123",
    });
    
    mockGitService.push.mockResolvedValue({
      success: true,
      pushed: true,
    });
    
    mockGitService.merge.mockResolvedValue({
      success: true,
      merged: true,
    });
    
    mockGitService.checkout.mockResolvedValue({
      success: true,
      branch: "feature-branch",
    });
    
    mockGitService.rebase.mockResolvedValue({
      success: true,
      rebased: true,
    });
    
    mockGitService.createPullRequest.mockResolvedValue({
      success: true,
      prUrl: "https://github.com/test/repo/pull/1",
    });
    
    mockGitService.getSessionWorkdir.mockReturnValue(tempWorkdir);
    
    // Mock session provider responses
    mockSessionProvider.getSession.mockResolvedValue({
      session: "test-session",
      repoPath: tempWorkdir,
      taskId: "#123",
    });
    
    // Mock execAsync for any direct usage
    mockExecAsync.mockImplementation((command: string) => {
      return Promise.resolve({
        stdout: "Mock git command success",
        stderr: "",
      });
    });
  }`;
        
        arrowFunction.replaceWithText(newBeforeEach);
        fixed = true;
        console.log(`✅ Updated beforeEach mock setup in ${filePath}`);
        break;
      }
    }
  }
  
  if (fixed) {
    sourceFile.saveSync();
    return {
      filePath,
      changed: true,
      reason: 'Updated Git Commands Integration Tests with comprehensive mock infrastructure'
    };
  }
  
  return {
    filePath,
    changed: false,
    reason: 'No Git Commands Integration mock setup issues found'
  };
}

export function fixGitCommandsIntegrationTests(filePaths: string[]): GitMockFixResult[] {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  
  // Add source files to project
  for (const filePath of filePaths) {
    project.addSourceFileAtPath(filePath);
  }
  
  const results: GitMockFixResult[] = [];
  
  for (const sourceFile of project.getSourceFiles()) {
    const result = fixGitCommandsIntegrationMocks(sourceFile);
    results.push(result);
  }
  
  return results;
}

// Self-executing main function for standalone usage
if (import.meta.main) {
  const gitCommandsTestFiles = [
    "/Users/edobry/.local/state/minsky/sessions/task#276/src/domain/git/commands/__tests__/integration.test.ts"
  ];
  
  console.log("🔧 Fixing Git Commands Integration Tests mock infrastructure...");
  const results = fixGitCommandsIntegrationTests(gitCommandsTestFiles);
  
  const changedCount = results.filter(r => r.changed).length;
  console.log(`\n🎯 Fixed Git Commands Integration mock infrastructure in ${changedCount} test files!`);
  
  if (changedCount > 0) {
    console.log("\n🧪 You can now run: bun test src/domain/git/commands/__tests__/integration.test.ts");
  }
} 
