import { describe, expect, it, mock } from 'bun:test';
import { GitService } from './git';
import type { PrOptions } from './git';

// Mock the modules
mock.module('child_process', () => ({
  exec: mock(() => Promise.resolve({ stdout: '', stderr: '' })),
  promisify: mock((fn) => fn)
}));

mock.module('fs/promises', () => ({
  mkdir: mock(() => Promise.resolve(undefined))
}));

mock.module('./session', () => ({
  SessionDB: mock(() => ({
    getSession: mock(() => Promise.resolve(null))
  }))
}));

describe('GitService.pr method', () => {
  it('should throw error if neither session nor repoPath provided', async () => {
    // Arrange
    const git = new GitService();
    const options: PrOptions = {};

    // Act & Assert
    await expect(git.pr(options)).rejects.toThrow('Either session or repoPath must be provided');
  });
}); 
