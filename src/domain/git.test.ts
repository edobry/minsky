/// <reference types="bun-types" />

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { GitService } from './git';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { ExecOptions, ExecException } from 'child_process';

// Define the callback type since it's not exported
type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

// Create a mock exec function that captures calls and accepts a callback
const mockExec = mock((command: string, options: any, callback: ExecCallback) => {
  // Call the callback with success
  if (callback) {
    callback(null, 'mock stdout', '');
  }
});

// Mock the childExec module
mock.module('child_process', () => ({
  exec: mockExec
}));

// Mock fs/promises
mock.module('fs/promises', () => ({
  mkdir: mock(async () => {})
}));

describe('GitService', () => {
  beforeEach(() => {
    mockExec.mockClear();
  });

  afterEach(() => {
    mock.restore();
  });

  it('clone: should create session repo under per-repo directory', async () => {
    // Arrange
    const git = new GitService();
    const repoUrl = 'https://github.com/example/test-repo';
    const session = `test-session-${randomBytes(4).toString('hex')}`;

    // Act
    const result = await git.clone({
      repoUrl,
      session
    });
    
    // Assert
    // Check that exec was called with the right command
    expect(mockExec).toHaveBeenCalled();
    const firstCall = mockExec.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      expect(firstCall[0]).toBe(`git clone ${repoUrl} ${join(git['baseDir'], session)}`);
    }
    
    // Check the result
    expect(result.workdir).toBe(join(git['baseDir'], session));
    expect(result.session).toBe(session);
  });

  it('branch: should work with per-repo directory structure', async () => {
    // Arrange
    const git = new GitService();
    const session = 'test-session';
    const branch = 'feature/test';

    // Act
    const result = await git.branch({ session, branch });
    
    // Assert
    // Check that exec was called with the right command
    expect(mockExec).toHaveBeenCalled();
    const firstCall = mockExec.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      expect(firstCall[0]).toBe(`git -C ${join(git['baseDir'], session)} checkout -b ${branch}`);
    }
    
    // Check the result
    expect(result.workdir).toBe(join(git['baseDir'], session));
    expect(result.branch).toBe(branch);
  });
});
