# Implementation Plan: Mandatory Task-Session Association

## Core Changes Required

### 1. Session Start Command

**Files to modify:**

- `src/schemas/session.ts` - Add `description` parameter, make task association required
- `src/adapters/shared/commands/session.ts` - Update command parameters
- `src/domain/session.ts` - Implement auto-creation logic, remove taskless session support

### 2. Task Auto-Creation

**Files to modify:**

- `src/domain/tasks.ts` - Add task creation from description function

## Implementation Steps

- [ ] Add `description` parameter to session start command
- [ ] Implement task auto-creation from description
- [ ] Use task ID as session name when using `--description` (like existing `--task` behavior)
- [ ] Make task association mandatory - require either `--task` or `--description`
- [ ] Create migration script for existing taskless sessions:
  - [ ] Examine each taskless session for unmerged work
  - [ ] Output warnings for sessions with unmerged changes (manual inspection required)
  - [ ] Auto-delete sessions with no unmerged work
- [ ] Remove all code that handles taskless sessions

## Key Functions to Implement

```typescript
// Auto-create task from description
async function createTaskFromDescription(description: string): Promise<Task>;

// Updated session start with mandatory task association
async function startSessionFromParams(params: {
  task?: string;
  description?: string;
  // other existing params
}): Promise<Session>;
```
