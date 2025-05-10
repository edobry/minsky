/**
 * Tests for the repository backends implementation.
 */

import { RepositoryBackendType } from '../repository.js';
import { LocalGitBackend } from '../localGitBackend.js';
import { RemoteGitBackend } from '../remoteGitBackend.js';
import { RepositoryError } from '../../utils/repository-utils.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Mock execAsync to avoid actual Git commands
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: jest.fn((fn) => {
    if (fn === exec) {
      return jest.fn(async () => ({ stdout: '', stderr: '' }));
    }
    return jest.requireActual('util').promisify(fn);
  })
}));

// Mock existsSync to simulate file system checks
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true)
}));

// Mock mkdir to avoid actual file system operations
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  mkdir: jest.fn().mockResolvedValue(undefined)
}));

describe('Repository Backends', () => {
  // Reset mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
    (execAsync as jest.Mock).mockResolvedValue({ stdout: '', stderr: '' });
  });

  describe('LocalGitBackend', () => {
    it('should create an instance with correct configuration', () => {
      const config = {
        type: RepositoryBackendType.LOCAL,
        path: '/test/path'
      };
      
      const backend = new LocalGitBackend(config);
      
      expect(backend.getConfig()).toEqual({
        type: RepositoryBackendType.LOCAL,
        path: '/test/path'
      });
    });

    it('should validate a local repository configuration', async () => {
      const config = {
        type: RepositoryBackendType.LOCAL,
        path: '/test/path'
      };
      
      const backend = new LocalGitBackend(config);
      
      // Mock successful Git repository validation
      (execAsync as jest.Mock).mockResolvedValueOnce({ stdout: '.git', stderr: '' });
      
      const result = await backend.validate();
      
      expect(result.valid).toBe(true);
      expect(execAsync).toHaveBeenCalledWith('git -C /test/path rev-parse --git-dir');
    });

    it('should fail validation when path is missing', async () => {
      const config = {
        type: RepositoryBackendType.LOCAL
      };
      
      const backend = new LocalGitBackend(config);
      
      const result = await backend.validate();
      
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Repository path is required for local Git backend');
    });
  });

  describe('RemoteGitBackend', () => {
    it('should create an instance with correct configuration', () => {
      const config = {
        type: RepositoryBackendType.REMOTE,
        url: 'https://github.com/org/repo.git'
      };
      
      const backend = new RemoteGitBackend(config);
      
      expect(backend.getConfig()).toEqual({
        type: RepositoryBackendType.REMOTE,
        url: 'https://github.com/org/repo.git'
      });
    });

    it('should throw error when URL is missing', () => {
      const config = {
        type: RepositoryBackendType.REMOTE
      };
      
      expect(() => {
        new RemoteGitBackend(config);
      }).toThrow(RepositoryError);
    });

    it('should validate a remote repository configuration', async () => {
      const config = {
        type: RepositoryBackendType.REMOTE,
        url: 'https://github.com/org/repo.git'
      };
      
      const backend = new RemoteGitBackend(config);
      
      // Mock successful remote repository validation
      (execAsync as jest.Mock).mockImplementation(async (cmd) => {
        if (cmd.includes('ls-remote')) {
          return { stdout: 'refs/heads/main', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      const result = await backend.validate();
      
      expect(result.valid).toBe(true);
      expect(execAsync).toHaveBeenCalledWith(expect.stringContaining('ls-remote'));
    });
  });
}); 
