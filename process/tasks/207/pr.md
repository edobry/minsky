# feat(#207): Add CLOSED task status for irrelevant tasks

## Summary

This PR implements a new CLOSED task status for tasks that are no longer relevant but should not be deleted from the task list. The CLOSED status provides a way to mark tasks as inactive while preserving their history and context.

## Changes

### Added

- **CLOSED Status Support**: Added CLOSED to task status constants with "!" checkbox representation
- **Schema Validation**: Updated task schemas to include CLOSED status validation  
- **CLI Integration**: Added CLOSED status support to all CLI commands (list, filter, set status)
- **Backend Configuration**: Updated GitHub backend and migration utilities for CLOSED status
- **Test Coverage**: Added comprehensive test coverage for CLOSED status functionality

### Fixed

- **Critical Bug in TaskService.setTaskStatus()**: Fixed ID normalization bug that prevented all task status updates from working
  - **Root Cause**: Normalized IDs from `getTask()` didn't match raw IDs from parsed tasks array
  - **Solution**: Implemented consistent ID normalization for proper task matching
  - **Impact**: This fix resolves status update failures for ALL task statuses, not just CLOSED

## Technical Implementation Details

### Core Status Definition

```typescript
// src/domain/tasks/taskConstants.ts
export const TASK_STATUS = {
  TODO: "TODO",
  IN_PROGRESS: "IN_PROGRESS", 
  DONE: "DONE",
  CLOSED: "CLOSED",  // New status
} as const;

export const TASK_STATUS_CHECKBOX_MAP = {
  [TASK_STATUS.TODO]: "[ ]",
  [TASK_STATUS.IN_PROGRESS]: "[~]",
  [TASK_STATUS.DONE]: "[x]", 
  [TASK_STATUS.CLOSED]: "[!]",  // New checkbox representation
} as const;
```

### Critical Bug Fix

**Before (Broken)**:
```typescript
const task = await this.getTask(id);  // Returns normalized ID
const updatedTasks = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));
// FAILS: task.id is normalized, but t.id is raw
```

**After (Fixed)**:
```typescript
const normalizedId = normalizeTaskId(id);
const taskIndex = tasks.findIndex((t) => {
  const taskNormalizedId = normalizeTaskId(t.id);
  return taskNormalizedId === normalizedId;  // Consistent comparison
});
```

### Schema Updates

```typescript
// src/schemas/tasks.ts
export const TaskStatusSchema = z.enum([
  "TODO", 
  "IN_PROGRESS", 
  "DONE", 
  "CLOSED"  // Added CLOSED
]);
```

### CLI Integration

- **Status Setting**: `minsky tasks status set 207 CLOSED`
- **Status Filtering**: `minsky tasks list --filter CLOSED`
- **Status Display**: Tasks show `[!]` checkbox for CLOSED status

## Validation and Testing

### Manual Testing Results

1. **Status Setting**: ✅ Successfully changes task status to CLOSED
2. **Persistence**: ✅ Status persists to tasks.md file with `[!]` checkbox
3. **Bidirectional Changes**: ✅ Can change TODO ↔ CLOSED in both directions
4. **CLI Commands**: ✅ All task CLI commands work with CLOSED status
5. **Schema Validation**: ✅ CLOSED status passes all validation checks

### Test Examples

```bash
# Set task to CLOSED status
$ bun run ./src/cli.ts tasks status set 207 CLOSED
✅ Task #207 status updated to CLOSED

# Verify in tasks.md file
$ grep "207" process/tasks.md
- [!] Add CLOSED task status for irrelevant tasks [#207]

# List CLOSED tasks
$ bun run ./src/cli.ts tasks list --filter CLOSED
[!] #207: Add CLOSED task status for irrelevant tasks
```

### Critical Bug Impact

The TaskService.setTaskStatus bug fix is significant because:

- **Scope**: Affected ALL task status updates, not just new CLOSED status
- **Symptoms**: Status changes appeared to succeed but weren't persisted
- **Root Cause**: ID normalization mismatch between getTask() and task array
- **Resolution**: Consistent ID normalization throughout the update process

## Usage Examples

### Setting CLOSED Status
```bash
minsky tasks status set <task-id> CLOSED
```

### Filtering CLOSED Tasks
```bash
minsky tasks list --filter CLOSED
```

### Checkbox Representation
- `[ ]` - TODO
- `[~]` - IN_PROGRESS  
- `[x]` - DONE
- `[!]` - CLOSED (new)

## Future Considerations

1. **UI Integration**: Consider how CLOSED tasks should be displayed in any future UI
2. **Reporting**: CLOSED tasks could be included in completion statistics
3. **Cleanup**: Potential future automation to archive very old CLOSED tasks
4. **Filtering**: Additional filter combinations (e.g., "active" = TODO + IN_PROGRESS)

## Checklist

- [x] All requirements implemented
- [x] Critical bug in TaskService.setTaskStatus fixed
- [x] All tests pass (manual verification)
- [x] Schema validation working
- [x] CLI integration complete
- [x] Documentation updated
- [x] Checkbox representation working (`[!]` for CLOSED)
- [x] Bidirectional status changes verified
- [x] Task persistence confirmed
