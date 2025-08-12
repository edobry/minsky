# Task #344: Fix task ID collision bug in JSON backend

## Description

Fix critical task ID generation bug in JsonFileTaskBackend that causes task ID collisions when using `session start --description`.

## Problem

The JSON task backend uses flawed logic for generating new task IDs:

```typescript
const tasks = await this.getAllTasks();
const nextIdNumber = tasks.length + 1; // ❌ WRONG!
```

This causes collisions because:

1. `getAllTasks()` reads from database, not filesystem
2. Database may have fewer tasks than filesystem task files
3. Using `length + 1` instead of `max(existingIds) + 1`

## Evidence

- Task #341 collision occurred during session start
- Two task files created: `341-implement-pre-commit...` and `341-move-ai-commands...`
- `tasks.length` was likely much smaller than 341

## Root Cause

**File**: `src/domain/tasks/jsonFileTaskBackend.ts` lines 382-387:

```typescript
// Get all existing tasks to determine the new task's ID
const tasks = await this.getAllTasks();

// TASK 283: Generate plain ID format for storage (e.g., "284" instead of "#284")
const nextIdNumber = tasks.length + 1; // ❌ BUG HERE!
taskId = String(nextIdNumber); // Plain format for storage
```

## Solution

Use the same logic as the Markdown backend:

```typescript
const tasks = await this.getAllTasks();
const maxId = tasks.reduce((max, task) => {
  const id = getTaskIdNumber(task.id);
  return id !== null && id > max ? id : max;
}, 0);
const nextIdNumber = maxId + 1;
```

## Files to Fix

- `src/domain/tasks/jsonFileTaskBackend.ts` - Fix task ID generation logic

## Acceptance Criteria

- [ ] Task ID generation uses max ID + 1, not length + 1
- [ ] No more task ID collisions when creating new tasks
- [ ] Works correctly even if database and filesystem are out of sync
- [ ] Uses existing `getTaskIdNumber` utility for ID parsing
- [ ] Maintains compatibility with existing task ID formats

## Priority

**CRITICAL** - This prevents basic workflow operations from working

## Impact

- Breaks `session start --description` command
- Creates duplicate task files
- Causes session creation failures
- Makes task management unreliable
