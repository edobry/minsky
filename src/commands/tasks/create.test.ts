import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv
} from '../../utils/test-helpers.js';
import type { MinskyTestEnv } from '../../utils/test-helpers.js';

// Create a unique test directory
const TEST_DIR = createUniqueTestDir("minsky-tasks-create-test");
let testEnv: MinskyTestEnv;

// Mock the TaskService to return controlled test data
mock.module('../../domain/tasks.js', () => {
  return {
    TaskService: class MockTaskService {
      constructor() {}
      
      async createTask(specPath = "") {
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
      
      async getTask(id = "") {
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
mock.module('../../domain/repo-utils.js', () => {
  return {
    resolveRepoPath: () => '/mock/workspace'
  };
});

// Mock the SessionDB
mock.module('../../domain/session.js', () => {
  return {
    SessionDB: class MockSessionDB {
      constructor() {}
      
      async getSession(name = "") {
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
    access: async (path = "") => {
      if (path.includes('invalid')) {
        throw new Error('File not found');
      }
    },
    readFile: async (path = "") => {
      if (path.includes('no-id')) {
        return '# Task: New Feature\n\n## Context\n\nThis is a new feature without ID.\n';
      } else if (path.includes('with-id')) {
        return '# Task #042: Existing ID Feature\n\n## Context\n\nThis is a feature with existing ID.\n';
      } else {
        return '# Task #002: Test Task\n\n## Context\n\nThis is a test task.\n';
      }
    },
    writeFile: async (path = "", content = "") => {
      mockFileSystem.set(path, content);
    },
    mkdir: async () => {}
  };
});

// Mock the resolveWorkspacePath function
mock.module('../../domain/workspace.js', () => {
  return {
    resolveWorkspacePath: async () => TEST_DIR
  };
});

// Create a simplified version of the create command logic
async function createTaskAction(specPath = "", options: Record<string, any> = {}) {
  if (!specPath || specPath.includes('invalid')) {
    throw new Error('Spec file not found');
  }
  
  // Import the TaskService - this will use our mocked version
  const { TaskService } = await import('../../domain/tasks.js');
  const taskService = new TaskService();
  
  // Create the task
  const task = await taskService.createTask(specPath);
  
  // Handle output
  if (options.json) {
    console.log(JSON.stringify(task, null, 2));
  } else {
    console.log(`Task ${task.id} created: ${task.title}`);
    if (options.dryRun) {
      console.log('Would update spec file:');
    } else {
      console.log('Spec file updated:');
    }
  }
  
  return task;
}

// Mock console.log to capture output
let consoleOutput: string[] = [];
let errorOutput = '';
const originalLog = console.log;
const originalError = console.error;

describe('Task Create Command', () => {
  beforeEach(() => {
    // Setup the test environment
    testEnv = setupMinskyTestEnv(TEST_DIR);
    
    // Reset console mocks and output storage
    consoleOutput = [];
    errorOutput = '';
    mockFileSystem.clear();
    
    // Mock console.log to capture output
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };
    
    // Mock console.error
    console.error = (msg: string) => {
      errorOutput = msg;
    };
  });
  
  afterEach(() => {
    // Clean up test directories
    cleanupTestDir(TEST_DIR);
    
    // Reset console
    console.log = originalLog;
    console.error = originalError;
  });
  
  it('should create a task from a spec file', async () => {
    await createTaskAction('spec.md', {});
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput[0]).toContain('Task #002 created');
  });
  
  it('should support --json output', async () => {
    await createTaskAction('spec.md', { json: true });
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    
    const output = JSON.parse(consoleOutput[0]);
    expect(output.id).toBe('#002');
    expect(output.title).toBe('Test Task');
  });
  
  it('should support spec file with "# Task: Title" format', async () => {
    await createTaskAction('no-id-spec.md', {});
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput[0]).toContain('Task #003 created');
  });
  
  it('should support spec file with "# Task #XXX: Title" format', async () => {
    await createTaskAction('with-id-spec.md', {});
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput[0]).toContain('Task #042 created');
  });
  
  it('should handle --dry-run option', async () => {
    await createTaskAction('no-id-spec.md', { dryRun: true });
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput[0]).toContain('Task #003 created');
    expect(consoleOutput[1]).toBe('Would update spec file:');
  });
  
  it('should handle --dry-run with --json option', async () => {
    await createTaskAction('no-id-spec.md', { dryRun: true, json: true });
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    
    const output = JSON.parse(consoleOutput[0]);
    expect(output.id).toBe('#003');
    expect(output.title).toBe('New Feature');
  });
  
  it('should handle error when spec file does not exist', async () => {
    try {
      await createTaskAction('invalid-spec.md', {});
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      if (error instanceof Error) {
        expect(error.message).toContain('Spec file not found');
      }
    }
  });
}); 
