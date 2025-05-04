import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MarkdownTaskBackend } from './tasks';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

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

describe('MarkdownTaskBackend Spec Path Handling', () => {
  let tmpDir: string;
  let tasksPath: string;
  let backend: MarkdownTaskBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/minsky-tasks-path-test-');
    const processDir = join(tmpDir, 'process');
    mkdirSync(processDir);
    const tasksDir = join(processDir, 'tasks');
    mkdirSync(tasksDir);
    tasksPath = join(processDir, 'tasks.md');
    writeFileSync(tasksPath, SAMPLE_TASKS_MD);
    backend = new MarkdownTaskBackend(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns correct specPath when spec file exists with standardized naming format', async () => {
    // Create a spec file with standardized name format (001-first-task.md)
    const specPath = join(tmpDir, 'process', 'tasks', '001-first-task.md');
    writeFileSync(specPath, '# Task #001: First Task');

    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBe('process/tasks/001-first-task.md');
  });

  it('finds and returns correct specPath when file exists with different name', async () => {
    // Create a spec file with a different name but correct ID prefix
    const specPath = join(tmpDir, 'process', 'tasks', '001-different-name.md');
    writeFileSync(specPath, '# Task #001: First Task');

    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBe('process/tasks/001-different-name.md');
  });

  it('handles multiple spec files with same ID prefix correctly', async () => {
    // Create multiple spec files with same ID prefix
    const specPath1 = join(tmpDir, 'process', 'tasks', '001-first-task.md');
    const specPath2 = join(tmpDir, 'process', 'tasks', '001-different-name.md');
    writeFileSync(specPath1, '# Task #001: First Task');
    writeFileSync(specPath2, '# Task #001: First Task (Old)');

    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    // Should return the first matching file it finds
    expect(task?.specPath).toBe('process/tasks/001-first-task.md');
  });

  it('returns undefined specPath when spec file does not exist', async () => {
    // Don't create any spec files
    // Make sure there are no files in the tasks directory
    const files = require('fs').readdirSync(join(tmpDir, 'process', 'tasks'));
    expect(files.length).toBe(0);
    
    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBeUndefined();
  });

  it('handles missing tasks directory gracefully', async () => {
    // Remove the tasks directory
    rmSync(join(tmpDir, 'process', 'tasks'), { recursive: true, force: true });

    const task = await backend.getTask('#001');
    expect(task).not.toBeNull();
    expect(task?.specPath).toBeUndefined();
  });

  it('handles malformed task IDs gracefully', async () => {
    const task = await backend.getTask('#invalid');
    expect(task).toBeNull();
  });
}); 
