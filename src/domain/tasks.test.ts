import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { MarkdownTaskBackend, TaskService, TASK_STATUS } from './tasks';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveRepoPath } from './repo-utils';
import type { RepoResolutionOptions } from './repo-utils';
import path from 'path';

const SAMPLE_TASKS_MD = `
# Tasks

## Example

\`\`\`markdown
- [ ] Example Task [#999](tasks/999-example.md)
\`\`\`

- [ ] First Task [#001](tasks/001-first.md)
  - This is the first task description
- [x] Second Task [#002](tasks/002-second.md)
- [ ] Third Task [#003](tasks/003-third.md)

- [ ] Malformed Task #004 (no link)
- [ ] Not a real task
`;

describe('MarkdownTaskBackend', () => {
  let tmpDir: string;
  let tasksPath: string;
  let backend: MarkdownTaskBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/minsky-tasks-test-');
    const processDir = join(tmpDir, 'process');
    require('fs').mkdirSync(processDir);
    tasksPath = join(processDir, 'tasks.md');
    writeFileSync(tasksPath, SAMPLE_TASKS_MD);
    backend = new MarkdownTaskBackend(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all real tasks, ignoring code blocks and malformed lines', async () => {
    const tasks = await backend.listTasks();
    expect(tasks.length).toBe(3);
    expect(tasks.map(t => t.id)).toEqual(['#001', '#002', '#003']);
    expect(tasks.map(t => t.title)).toContain('First Task');
    expect(tasks.map(t => t.title)).toContain('Second Task');
    expect(tasks.map(t => t.title)).toContain('Third Task');
  });

  it('filters tasks by status', async () => {
    const done = await backend.listTasks({ status: 'DONE' });
    expect(done.length).toBe(1);
    expect(done[0]?.id).toBe('#002');
    const todo = await backend.listTasks({ status: 'TODO' });
    expect(todo.length).toBe(2);
    expect(todo.map(t => t.id)).toEqual(['#001', '#003']);
  });

  it('gets a task by id', async () => {
    const task = await backend.getTask('#001');
    expect(task).toBeTruthy();
    expect(task?.title).toBe('First Task');
    expect(task?.description).toContain('first task description');
  });

  it('gets a task status', async () => {
    expect(await backend.getTaskStatus('#002')).toBe('DONE');
    expect(await backend.getTaskStatus('#003')).toBe('TODO');
  });

  it('sets a task status and persists the change', async () => {
    await backend.setTaskStatus('#003', 'DONE');
    let task = await backend.getTask('#003');
    expect(task?.status).toBe('DONE');
    // Check file content
    const file = readFileSync(tasksPath, 'utf-8');
    expect(file).toMatch(/- \[x\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus('#003', 'TODO');
    task = await backend.getTask('#003');
    expect(task?.status).toBe('TODO');
    const file2 = readFileSync(tasksPath, 'utf-8');
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it('sets a task status to IN-PROGRESS and persists the change', async () => {
    await backend.setTaskStatus('#003', 'IN-PROGRESS');
    let task = await backend.getTask('#003');
    expect(task?.status).toBe('IN-PROGRESS');
    // Check file content
    const file = readFileSync(tasksPath, 'utf-8');
    expect(file).toMatch(/- \[-\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus('#003', 'TODO');
    task = await backend.getTask('#003');
    expect(task?.status).toBe('TODO');
    const file2 = readFileSync(tasksPath, 'utf-8');
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it('sets a task status to IN-REVIEW and persists the change', async () => {
    await backend.setTaskStatus('#003', 'IN-REVIEW');
    let task = await backend.getTask('#003');
    expect(task?.status).toBe('IN-REVIEW');
    // Check file content
    const file = readFileSync(tasksPath, 'utf-8');
    expect(file).toMatch(/- \[\+\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus('#003', 'TODO');
    task = await backend.getTask('#003');
    expect(task?.status).toBe('TODO');
    const file2 = readFileSync(tasksPath, 'utf-8');
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it('ignores tasks in code blocks', async () => {
    const tasks = await backend.listTasks();
    expect(tasks.find(t => t.id === '#999')).toBeUndefined();
  });

  it('ignores malformed lines', async () => {
    const tasks = await backend.listTasks();
    expect(tasks.find(t => t.title && t.title.includes('Malformed'))).toBeUndefined();
    expect(tasks.find(t => t.title && t.title.includes('Not a real task'))).toBeUndefined();
  });

  it('throws on invalid status for setTaskStatus', async () => {
    await expect(backend.setTaskStatus('#001', 'INVALID')).rejects.toThrow();
  });

  it('does nothing if task id does not exist for setTaskStatus', async () => {
    // Should not throw, should not change file
    const before = readFileSync(tasksPath, 'utf-8');
    await backend.setTaskStatus('#999', 'DONE');
    const after = readFileSync(tasksPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('returns null for getTask/getTaskStatus on missing id', async () => {
    expect(await backend.getTask('#999')).toBeNull();
    expect(await backend.getTaskStatus('#999')).toBeNull();
  });

  it('handles multiple code blocks and tasks in between', async () => {
    const md = `
# Tasks
\n\`\`\`markdown\n- [ ] In code block [#100](tasks/100.md)\n\`\`\`\n- [ ] Real Task [#101](tasks/101.md)\n\`\`\`\n- [ ] Also in code block [#102](tasks/102.md)\n\`\`\`\n- [x] Real Done [#103](tasks/103.md)\n`;
    writeFileSync(tasksPath, md);
    const tasks = await backend.listTasks();
    expect(tasks.length).toBe(2);
    expect(tasks.map(t => t.id)).toEqual(['#101', '#103']);
  });
});

describe('TaskService', () => {
  let tmpDir: string;
  let tasksPath: string;
  let service: TaskService;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/minsky-tasks-test-');
    const processDir = join(tmpDir, 'process');
    require('fs').mkdirSync(processDir);
    tasksPath = join(processDir, 'tasks.md');
    writeFileSync(tasksPath, SAMPLE_TASKS_MD);
    service = new TaskService({ workspacePath: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists tasks via TaskService', async () => {
    const tasks = await service.listTasks();
    expect(tasks.length).toBe(3);
  });

  it('gets and sets task status via TaskService', async () => {
    expect(await service.getTaskStatus('#001')).toBe('TODO');
    await service.setTaskStatus('#001', 'DONE');
    expect(await service.getTaskStatus('#001')).toBe('DONE');
  });

  it('throws if backend is not found', () => {
    expect(() => new TaskService({ workspacePath: tmpDir, backend: 'notreal' })).toThrow();
  });
});

// Mock fs
mock.module('fs', () => ({
  promises: {
    readFile: async (path: string) => {
      if (path.endsWith('tasks.md')) {
        return `# Tasks\n\n- [ ] Task 1 [#001](process/tasks/001-task-1.md)\n`;
      }
      if (path.endsWith('spec.md')) {
        return `# Task #999: Test Task\n\n## Context\n\nThis is a test task context.\n\n## Requirements\n\n- Do something\n`;
      }
      return '';
    },
    writeFile: async () => {},
    mkdir: async () => {},
    access: async () => {}
  }
}));

// Add createTask tests
describe('createTask', () => {
  const workspacePath = '/test/workspace';
  let taskBackend: MarkdownTaskBackend;
  let taskService: TaskService;

  beforeEach(() => {
    taskBackend = new MarkdownTaskBackend(workspacePath);
    taskService = new TaskService({ workspacePath });
  });

  it('should parse spec file and create a new task', async () => {
    const specPath = path.join(workspacePath, 'process/tasks/spec.md');
    
    // Mock parseTasks to return tasks with ID 001
    spyOn(taskBackend, 'parseTasks').mockImplementation(async () => [
      { id: '#001', title: 'Task 1', description: '', status: TASK_STATUS.TODO, specPath: 'process/tasks/001-task-1.md' }
    ]);

    // Temporarily access private method for testing
    // @ts-ignore - accessing private method for testing
    spyOn(taskBackend, 'createTask').mockRestore();
    
    const task = await taskBackend.createTask(specPath);
    
    expect(task).toBeDefined();
    expect(task.id).toBe('#002');
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe(TASK_STATUS.TODO);
    expect(task.description).toBeTruthy();
    expect(task.specPath).toBe(specPath);
  });

  it('should throw error if spec file does not exist', async () => {
    const invalidPath = '/invalid/path.md';
    
    // Mock fs.access to throw an error
    mock.module('fs', () => ({
      promises: {
        access: async () => { throw new Error('File not found'); }
      }
    }));
    
    await expect(taskBackend.createTask(invalidPath)).rejects.toThrow('Spec file not found');
  });

  it('should throw error if spec file has invalid format', async () => {
    const specPath = path.join(workspacePath, 'process/tasks/invalid-spec.md');
    
    // Mock fs.readFile to return invalid content
    mock.module('fs', () => ({
      promises: {
        readFile: async () => 'Invalid spec content',
        access: async () => {}
      }
    }));
    
    await expect(taskBackend.createTask(specPath)).rejects.toThrow('Invalid spec file');
  });
}); 
