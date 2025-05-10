import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createStatusCommand } from './status';
import { TaskService, TASK_STATUS } from '../../domain/tasks';
import * as p from '@clack/prompts';

// Mock the TaskService
mock.module('../../domain/tasks', () => {
  return {
    TaskService: class MockTaskService {
      constructor() {}
      
      async getTaskStatus(id: string) {
        if (id === '#001') {
          return 'TODO';
        } else if (id === '#002') {
          return 'DONE';
        } else if (id === '#003') {
          return 'IN-PROGRESS';
        } else if (id === '#004') {
          return 'IN-REVIEW';
        }
        return null;
      }
      
      async setTaskStatus(id: string, status: string) {
        // Just a mock implementation for testing
        return;
      }
      
      async getTask(id: string) {
        if (['#001', '#002', '#003', '#004'].includes(id)) {
          return {
            id: id,
            title: `Task ${id}`,
            status: id === '#002' ? 'DONE' : 'TODO',
            description: `This is task ${id}`
          };
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

// Mock the resolveWorkspacePath function
mock.module('../../domain/workspace', () => {
  return {
    resolveWorkspacePath: () => '/mock/workspace'
  };
});

// Mock the @clack/prompts module
mock.module('@clack/prompts', () => {
  return {
    select: async ({ message, options, initialValue }) => {
      // Return the initial value (simulating user selecting the default)
      return initialValue;
    },
    isCancel: (value) => value === Symbol.for('clack.cancel'),
    cancel: () => {}
  };
});

// Mock the task-utils module
mock.module('../../utils/task-utils', () => {
  return {
    normalizeTaskId: (id) => id.startsWith('#') ? id : `#${id}`
  };
});

// Get the status set command
const statusCommand = createStatusCommand();
const setCommand = statusCommand.commands.find(cmd => cmd.name() === 'set');
if (!setCommand) {
  throw new Error('Could not find set command');
}
const mockAction = setCommand._actionHandler;
if (!mockAction) {
  throw new Error('Could not access command action handler');
}

// Mock console and process.exit
let consoleOutput: string[] = [];
let errorOutput: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalStdoutIsTTY = process.stdout.isTTY;

describe('Status Set Command', () => {
  beforeEach(() => {
    consoleOutput = [];
    errorOutput = [];
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };
    console.error = (...args: any[]) => {
      errorOutput.push(args.join(' '));
    };
    process.exit = mock(() => {}) as any;
  });
  
  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    // Restore the original isTTY value
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true
    });
  });
  
  it('should set task status when status is provided', async () => {
    await mockAction('001', 'DONE', {});
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput.some(output => output.includes('Setting status for task #001 to: DONE'))).toBe(true);
    expect(consoleOutput.some(output => output.includes('Status for task #001 updated to: DONE'))).toBe(true);
  });
  
  it('should validate the provided status value', async () => {
    try {
      await mockAction('001', 'INVALID-STATUS', {});
    } catch (error) {
      // Process.exit is mocked and throws an error
    }
    
    expect(errorOutput.length).toBeGreaterThan(0);
    expect(errorOutput.some(output => output.includes('Invalid status: \'INVALID-STATUS\''))).toBe(true);
  });
  
  it('should prompt for status if not provided in interactive mode', async () => {
    // Mock TTY environment
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    
    // Mock p.select to return a specific status
    const originalSelect = p.select;
    p.select = mock(() => Promise.resolve('DONE')) as any;
    
    await mockAction('001', undefined, {});
    
    // Restore the original select function
    p.select = originalSelect;
    
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput.some(output => output.includes('Setting status for task #001 to: DONE'))).toBe(true);
    expect(consoleOutput.some(output => output.includes('Status for task #001 updated to: DONE'))).toBe(true);
  });
  
  it('should fail in non-interactive mode if status is not provided', async () => {
    // Mock non-TTY environment
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    
    try {
      await mockAction('001', undefined, {});
    } catch (error) {
      // Process.exit is mocked and throws an error
    }
    
    expect(errorOutput.length).toBeGreaterThan(0);
    expect(errorOutput.some(output => output.includes('Status is required in non-interactive mode'))).toBe(true);
  });
  
  it('should exit when the prompt is canceled', async () => {
    // Mock TTY environment
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    
    // Mock p.select and isCancel to simulate cancellation
    const originalSelect = p.select;
    const originalIsCancel = p.isCancel;
    p.select = mock(() => Promise.resolve(Symbol.for('clack.cancel'))) as any;
    p.isCancel = mock(() => true) as any;
    
    try {
      await mockAction('001', undefined, {});
    } catch (error) {
      // Process.exit is mocked and may throw
    }
    
    // Restore original functions
    p.select = originalSelect;
    p.isCancel = originalIsCancel;
    
    // Should call process.exit
    expect(process.exit).toHaveBeenCalledWith(0);
  });
  
  it('should use the current task status as the prompt default value', async () => {
    // Mock TTY environment
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    
    // Mock p.select to verify the initialValue
    const originalSelect = p.select;
    const selectMock = mock(() => Promise.resolve('TODO'));
    p.select = selectMock as any;
    
    await mockAction('003', undefined, {});
    
    // Restore the original select function
    p.select = originalSelect;
    
    // Check that select was called with the correct initial value
    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: 'IN-PROGRESS'
      })
    );
  });
}); 
