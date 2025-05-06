import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createCommand } from './create';
import { TaskService } from '../../domain/tasks';
import { join } from 'path';

// Mock the TaskService
mock.module('../../domain/tasks', () => {
  return {
    TaskService: class MockTaskService {
      constructor() {}
      
      async createTask(specPath: string, options = {}) {
        if (specPath.includes('no-id')) {
          return {
            id: '#003',
            title: 'New Feature',
            status: 'TODO',
            description: 'This is a new feature without ID.',
            specPath: 'process/tasks/003-new-feature.md'
          };
        } else if (specPath.includes('with-id')) {
          return {
            id: '#042',
            title: 'Existing ID Feature',
            status: 'TODO',
            description: 'This is a feature with existing ID.',
            specPath: 'process/tasks/042-existing-id-feature.md'
          };
        } else {
          return {
            id: '#002',
            title: 'Test Task',
            status: 'TODO',
            description: 'This is a test task.',
            specPath: 'process/tasks/002-test-task.md'
          };
        }
      }
      
      async listTasks() {
        return [
          { id: '#001', title: 'First Task', status: 'TODO', description: '' }
        ];
      }
      
      async getTask(id: string) {
        if (id === '#001') {
          return { id: '#001', title: 'First Task', status: 'TODO', description: '' };
        }
        return null;
      }
    },
    TASK_STATUS: {
      TODO: 'TODO',
      DONE: 'DONE',
      IN_PROGRESS: 'IN-PROGRESS',
      IN_REVIEW: 'IN-REVIEW',
    }
  };
});

// Mock the resolveRepoPath function
mock.module('../../domain/repo-utils', () => {
  return {
    resolveRepoPath: () => '/mock/workspace'
  };
});

// Mock the SessionDB
mock.module('../../domain/session', () => {
  return {
    SessionDB: class MockSessionDB {
      constructor() {}
      
      async getSession(name: string) {
        if (name === 'test-session') {
          return {
            name: 'test-session',
            repoUrl: '/mock/session/repo',
            branch: 'test-branch'
          };
        }
        return null;
      }
    }
  };
});

// Mock fs
const mockFileSystem = new Map<string, string>();
mock.module('fs/promises', () => {
  return {
    access: async (path: string) => {
      if (path.includes('invalid')) {
        throw new Error('File not found');
      }
    },
    readFile: async (path: string) => {
      if (path.includes('no-id')) {
        return '# Task: New Feature\n\n## Context\n\nThis is a new feature without ID.\n';
      } else if (path.includes('with-id')) {
        return '# Task #042: Existing ID Feature\n\n## Context\n\nThis is a feature with existing ID.\n';
      } else {
        return '# Task #002: Test Task\n\n## Context\n\nThis is a test task.\n';
      }
    },
    writeFile: async (path: string, content: string) => {
      mockFileSystem.set(path, content);
    },
    mkdir: async () => {}
  };
});

// Mock the action function directly
const mockAction = createCommand['_actionHandler'];
if (!mockAction) {
  throw new Error('Could not access command action handler');
}

// Mock console.log to capture output
let consoleOutput: string[] = [];
let errorOutput: string = '';
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

describe('createCommand', () => {
  beforeEach(() => {
    consoleOutput = [];
    errorOutput = '';
    mockFileSystem.clear();
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };
    console.error = (msg: string, error: string) => {
      errorOutput = error || msg;
    };
    process.exit = () => {
      throw new Error('Process exit called');
    };
  });
  
  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });
  
  it('should create a task from a spec file', async () => {
    await mockAction('spec.md', {});
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      expect(consoleOutput[0].includes('Task #002 created')).toBe(true);
    }
  });
  
  it('should support --json output', async () => {
    await mockAction('spec.md', { json: true });
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      const output = JSON.parse(consoleOutput[0]);
      expect(output.id).toBe('#002');
      expect(output.title).toBe('Test Task');
    }
  });
  
  it('should support spec file with "# Task: Title" format', async () => {
    await mockAction('no-id-spec.md', {});
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      expect(consoleOutput[0].includes('Task #003 created')).toBe(true);
    }
  });
  
  it('should support spec file with "# Task #XXX: Title" format', async () => {
    await mockAction('with-id-spec.md', {});
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      expect(consoleOutput[0].includes('Task #042 created')).toBe(true);
    }
  });
  
  it('should handle --dry-run option', async () => {
    await mockAction('no-id-spec.md', { dryRun: true });
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      expect(consoleOutput[0].includes('Would create task')).toBe(true);
      expect(consoleOutput.some(line => line.includes('Would update spec file:'))).toBe(true);
    }
  });
  
  it('should handle --dry-run with --json option', async () => {
    await mockAction('no-id-spec.md', { dryRun: true, json: true });
    
    expect(consoleOutput.length > 0).toBe(true);
    if (consoleOutput.length > 0) {
      const output = JSON.parse(consoleOutput[0]);
      expect(output.id).toBe('#003');
      expect(output.title).toBe('New Feature');
      expect(output.dryRun).toBe(true);
    }
  });
  
  it('should handle error when spec file does not exist', async () => {
    try {
      await mockAction('invalid-spec.md', {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(errorOutput.includes('Spec file not found')).toBe(true);
    }
  });
}); 
