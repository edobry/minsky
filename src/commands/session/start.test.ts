import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createStartCommand } from './start';
import * as startSessionModule from './startSession';
import * as repoUtils from '../../domain/repo-utils';

describe('createStartCommand', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalStartSession: typeof startSessionModule.startSession;
  let originalResolveRepoPath: typeof repoUtils.resolveRepoPath;
  let originalExit: typeof process.exit;
  
  const logCalls: string[] = [];
  const errorCalls: string[] = [];
  
  beforeEach(() => {
    // Save original functions
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalStartSession = startSessionModule.startSession;
    originalResolveRepoPath = repoUtils.resolveRepoPath;
    originalExit = process.exit;
    
    // Mock console.log and console.error
    console.log = (...args: any[]) => {
      logCalls.push(args.join(' '));
    };
    
    console.error = (...args: any[]) => {
      errorCalls.push(args.join(' '));
    };
    
    // Mock startSession
    startSessionModule.startSession = async () => ({
      sessionRecord: { session: 'test-session' },
      cloneResult: { workdir: '/path/to/test-workdir' },
      branchResult: { branch: 'test-branch' }
    });
    
    // Mock resolveRepoPath
    repoUtils.resolveRepoPath = async () => '/path/to/repo';
    
    // Mock process.exit
    process.exit = () => undefined as never;
    
    // Clear log and error calls
    logCalls.length = 0;
    errorCalls.length = 0;
  });
  
  afterEach(() => {
    // Restore original functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    startSessionModule.startSession = originalStartSession;
    repoUtils.resolveRepoPath = originalResolveRepoPath;
    process.exit = originalExit;
  });
  
  it('outputs verbose information when --quiet is not specified', async () => {
    // Arrange
    const command = createStartCommand();
    
    // Act - execute the command
    await command.parseAsync(['node', 'test', 'test-session', '--repo', '/path/to/repo']);
    
    // Assert
    // Should have multiple log lines when not in quiet mode
    expect(logCalls.length).toBeGreaterThan(1);
    
    // Verify specific output messages
    expect(logCalls.some(log => log.includes("Session 'test-session' started."))).toBe(true);
    expect(logCalls.some(log => log.includes("Repository cloned to:"))).toBe(true);
    expect(logCalls.some(log => log.includes("Branch 'test-branch' created."))).toBe(true);
    
    // Should include the workdir as the final output
    expect(logCalls[logCalls.length - 1]).toBe('/path/to/test-workdir');
  });
  
  it('outputs only the session directory path when --quiet is specified', async () => {
    // Arrange
    const command = createStartCommand();
    
    // Act - execute the command with --quiet
    await command.parseAsync(['node', 'test', 'test-session', '--repo', '/path/to/repo', '--quiet']);
    
    // Assert
    // Should have exactly one log line in quiet mode
    expect(logCalls.length).toBe(1);
    
    // Should output only the workdir path
    expect(logCalls[0]).toBe('/path/to/test-workdir');
  });
  
  it('properly handles errors in quiet mode', async () => {
    // Arrange
    const command = createStartCommand();
    
    // Mock startSession to throw an error
    startSessionModule.startSession = async () => {
      throw new Error('Test error message');
    };
    
    // Track process.exit calls
    let exitCode = 0;
    process.exit = (code = 0) => {
      exitCode = code;
      return undefined as never;
    };
    
    // Act - execute the command with --quiet
    await command.parseAsync(['node', 'test', 'test-session', '--repo', '/path/to/repo', '--quiet']);
    
    // Assert
    // Should log the error
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]).toContain('Error starting session:');
    expect(errorCalls[0]).toContain('Test error message');
    
    // Should exit with a non-zero status code
    expect(exitCode).toBe(1);
  });
}); 
