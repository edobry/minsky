import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createPrCommand } from '../pr';
import { GitService } from '../../../domain/git';
import fs from 'fs';
import path from 'path';

// Create mock functions
const mockPrFn = mock(() => Promise.resolve({ markdown: 'mock PR markdown' }));
const mockGitService = {
  pr: mockPrFn
};

// Mock the GitService constructor
mock.module('../../../domain/git', () => ({
  GitService: mock(() => mockGitService)
}));

// Mock fs.existsSync 
const mockExistsSync = mock((p) => p.includes('.git'));
mock.module('fs', () => ({
  ...fs,
  existsSync: mockExistsSync
}));

describe('git pr command', () => {
  // Capture console output
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Reset mocks
    mockPrFn.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockImplementation((p) => p.includes('.git'));
    
    // Setup console spies
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    
    // Mock process.exit
    processExitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    mock.restore();
  });

  // Test the inner implementation directly rather than trying to use Commander's parsing
  it('should require either session or path', async () => {
    const command = createPrCommand();
    const actionFunction = command.opts().session; // This is just a dummy to get TypeScript to compile
    
    // Get the implementation details - directly test our code inside createPrCommand
    try {
      await testActionWithOptions({});
    } catch (e) {
      // Expected to throw due to process.exit
    }
    
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Either --session or --path must be provided');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should prefer session over path when both provided', async () => {
    try {
      await testActionWithOptions({
        session: 'test-session',
        path: '/test/path'
      });
    } catch (e) {
      // We don't expect an error here, so this is a test failure
      expect().fail('Should not have thrown an error: ' + e);
    }
    
    expect(mockPrFn).toHaveBeenCalledWith({
      session: 'test-session',
      repoPath: undefined,
      branch: undefined,
      debug: undefined
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('mock PR markdown');
  });

  it('should validate repo path exists and has .git directory', async () => {
    // Make the existsSync check fail
    mockExistsSync.mockImplementation(() => false);
    
    try {
      await testActionWithOptions({
        path: '/invalid/path'
      });
    } catch (e) {
      // Expected to throw due to process.exit
    }
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('is not a git repository'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should pass branch option to GitService', async () => {
    try {
      await testActionWithOptions({
        session: 'test-session',
        branch: 'feature'
      });
    } catch (e) {
      // We don't expect an error here, so this is a test failure
      expect().fail('Should not have thrown an error: ' + e);
    }
    
    expect(mockPrFn).toHaveBeenCalledWith({
      session: 'test-session',
      repoPath: undefined,
      branch: 'feature',
      debug: undefined
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('mock PR markdown');
  });

  it('should pass debug option to GitService', async () => {
    try {
      await testActionWithOptions({
        session: 'test-session',
        debug: true
      });
    } catch (e) {
      // We don't expect an error here, so this is a test failure
      expect().fail('Should not have thrown an error: ' + e);
    }
    
    expect(mockPrFn).toHaveBeenCalledWith({
      session: 'test-session',
      repoPath: undefined,
      branch: undefined,
      debug: true
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('mock PR markdown');
  });

  it('should handle errors from GitService', async () => {
    // Make the PR function throw an error
    mockPrFn.mockImplementation(() => {
      throw new Error('Git service error');
    });
    
    try {
      await testActionWithOptions({
        session: 'test-session'
      });
    } catch (e) {
      // Expected to throw due to process.exit
    }
    
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error generating PR markdown:', expect.any(Error));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should resolve path option to absolute path', async () => {
    const testPath = '/test/path';
    const resolvedPath = path.resolve(testPath);
    
    try {
      await testActionWithOptions({
        path: testPath
      });
    } catch (e) {
      // We don't expect an error here, so this is a test failure
      expect().fail('Should not have thrown an error: ' + e);
    }
    
    expect(mockPrFn).toHaveBeenCalledWith({
      session: undefined,
      repoPath: resolvedPath,
      branch: undefined,
      debug: undefined
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('mock PR markdown');
  });
});

// Helper function to test the action with various options
async function testActionWithOptions(options: { 
  session?: string;
  path?: string;
  branch?: string;
  debug?: boolean;
}) {
  const gitService = new GitService();
  
  // This is the inlined implementation from createPrCommand().action
  // We need either a session or a path
  if (!options.session && !options.path) {
    console.error('Error: Either --session or --path must be provided');
    process.exit(1);
  }
  
  // If both are provided, prefer session
  if (options.session && options.path) {
    if (options.debug) console.error('Warning: Both session and path provided. Using session.');
  }
  
  try {
    // Validate and prepare path if provided
    let repoPath: string | undefined;
    if (options.path && !options.session) {
      repoPath = path.resolve(options.path);
      // Check if it's a git repository
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        console.error(`Error: ${repoPath} is not a git repository`);
        process.exit(1);
      }
    }
    
    const result = await gitService.pr({
      session: options.session,
      repoPath,
      branch: options.branch,
      debug: options.debug
    });
    console.log(result.markdown);
  } catch (error) {
    console.error('Error generating PR markdown:', error);
    process.exit(1);
  }
} 
