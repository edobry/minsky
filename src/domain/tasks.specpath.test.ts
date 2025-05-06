import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MarkdownTaskBackend } from './tasks';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MarkdownTaskBackend Spec Path Handling', () => {
  let tmpDir: string;
  let backend: MarkdownTaskBackend;
  let tasksDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'minsky-tasks-test-'));
    const processDir = join(tmpDir, 'process');
    mkdirSync(processDir);
    writeFileSync(join(processDir, 'tasks.md'), `
# Tasks
- [ ] First Task [#001](tasks/001-first.md)
- [ ] Second Task [#002](tasks/002-second.md)
- [ ] Task with Missing Spec [#003](tasks/003-missing.md)
- [ ] Task with Different Name [#004](tasks/004-different-name.md)
    `);
    
    // Create tasks directory and spec files
    tasksDir = join(processDir, 'tasks');
    mkdirSync(tasksDir);
    
    // Create standardized spec files
    writeFileSync(join(tasksDir, '001-first.md'), '# Task 001: First Task');
    writeFileSync(join(tasksDir, '002-second.md'), '# Task 002: Second Task');
    // 003-missing.md intentionally not created
    writeFileSync(join(tasksDir, '004-task-with-different-name.md'), '# Task 004: Different Name');
    
    // Create a subdirectory with legacy format
    mkdirSync(join(tasksDir, '005'));
    writeFileSync(join(tasksDir, '005', 'spec.md'), '# Task 005: Legacy Format');
    
    // Create multiple files with same ID prefix for testing
    writeFileSync(join(tasksDir, '006-first-version.md'), '# Task 006: First Version');
    writeFileSync(join(tasksDir, '006-second-version.md'), '# Task 006: Second Version');
    
    backend = new MarkdownTaskBackend(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined specPath when spec file does not exist', async () => {
    const task = await backend.getTask('#003');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBeUndefined();
  });

  it('returns correct specPath when spec file exists with standardized name', async () => {
    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBe('process/tasks/001-first.md');
  });

  it('finds and returns correct specPath when file exists with different name', async () => {
    const task = await backend.getTask('#004');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBe('process/tasks/004-task-with-different-name.md');
  });

  it('handles multiple spec files with same ID prefix correctly', async () => {
    // Mock the task parsing to test validateSpecPath directly
    const mockTask = {
      id: '#006',
      title: 'Multiple Files',
      status: 'TODO',
      description: ''
    };
    
    // We need to access the private method, so we'll use any type
    const specPath = await (backend as any).validateSpecPath(mockTask.id, mockTask.title);
    
    // It should find one of the 006 files (we don't care which one)
    expect(specPath).toBeDefined();
    expect(specPath).toMatch(/^process\/tasks\/006-.*\.md$/);
  });

  it('handles missing tasks directory gracefully', async () => {
    // Create a new backend with a non-existent tasks directory
    const newTmpDir = mkdtempSync(join(tmpdir(), 'minsky-no-tasks-dir-'));
    const processDir = join(newTmpDir, 'process');
    mkdirSync(processDir);
    writeFileSync(join(processDir, 'tasks.md'), `
# Tasks
- [ ] Test Task [#007](tasks/007-test.md)
    `);
    
    const newBackend = new MarkdownTaskBackend(newTmpDir);
    
    try {
      const task = await newBackend.getTask('#007');
      expect(task).not.toBeNull();
      expect(task?.specPath).toBeUndefined();
    } finally {
      rmSync(newTmpDir, { recursive: true, force: true });
    }
  });

  it('handles malformed task IDs gracefully', async () => {
    // Mock the task parsing to test validateSpecPath directly with a malformed ID
    const mockTask = {
      id: 'invalid',
      title: 'Invalid ID',
      status: 'TODO',
      description: ''
    };
    
    // We need to access the private method, so we'll use any type
    const specPath = await (backend as any).validateSpecPath(mockTask.id, mockTask.title);
    
    // It should return undefined for malformed IDs
    expect(specPath).toBeUndefined();
  });
}); 
