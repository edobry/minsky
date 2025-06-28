# feat(#207): Add CLOSED task status for irrelevant tasks

## Summary

This PR implements **Task #207** by adding a new CLOSED task status for tasks that are no longer relevant but shouldn't be deleted. The CLOSED status provides a way to mark tasks as inactive while preserving them for historical reference and audit purposes.

## Key Features

- **New CLOSED status**: Distinct from DONE, represents tasks that are no longer relevant
- **Checkbox representation**: Uses `!` character in markdown task lists
- **Full CLI support**: Available in status setting and filtering commands  
- **Backend compatibility**: Works with markdown, JSON-file, and GitHub Issues backends
- **Color coding**: Gray color scheme for GitHub Issues integration

## Changes

### Core Implementation

- **`src/domain/tasks/taskConstants.ts`**: Added CLOSED status constant and checkbox mappings
- **`src/schemas/tasks.ts`**: Added CLOSED to validation schemas
- **`src/adapters/shared/commands/tasks.ts`**: Added CLOSED to CLI command enums
- **`src/domain/tasks/taskService.ts`**: **CRITICAL BUG FIX** - Fixed task ID matching in setTaskStatus method

### Backend Support

- **`src/domain/tasks/githubBackendConfig.ts`**: Added gray color mapping for CLOSED status
- **`src/domain/tasks/githubIssuesTaskBackend.ts`**: Added CLOSED label support
- **`src/domain/tasks/migrationUtils.ts`**: Added CLOSED status mappings for backend migration

### Bug Fix - TaskService.setTaskStatus()

**Critical Issue Resolved**: Fixed a fundamental bug in `TaskService.setTaskStatus()` that prevented any status changes from being persisted to files.

**Root Cause**: Task ID normalization mismatch between lookup and update operations
```typescript
// BROKEN - Inconsistent ID formats
const task = await this.getTask(id);  // Normalized ID (#207)
const updatedTasks = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));  // Raw ID from file
```

**Solution**: Proper ID normalization for consistent matching
```typescript
// FIXED - Consistent normalization
const normalizedId = normalizeTaskId(id);
const taskIndex = tasks.findIndex((t) => {
  const taskNormalizedId = normalizeTaskId(t.id);
  return taskNormalizedId === normalizedId;
});
```

## Technical Details

### CLOSED Status Specifications

- **Status Value**: `"CLOSED"`
- **Checkbox Character**: `"!"` 
- **Use Case**: Tasks no longer relevant but shouldn't be deleted
- **Color (GitHub)**: Gray (`#6c757d`)
- **CLI Commands**: Available in `tasks status set` and `tasks list --status`

### File Changes

**Modified Files:**
- `src/domain/tasks/taskConstants.ts` - Core status definitions
- `src/schemas/tasks.ts` - Validation schemas  
- `src/adapters/shared/commands/tasks.ts` - CLI command support
- `src/domain/tasks/taskService.ts` - Bug fix for status updates
- `src/domain/tasks/githubBackendConfig.ts` - GitHub color mapping
- `src/domain/tasks/githubIssuesTaskBackend.ts` - GitHub label support
- `src/domain/tasks/migrationUtils.ts` - Backend migration mappings

### Validation & Testing

- ✅ **Constants verification**: CLOSED properly defined in all constants
- ✅ **Schema validation**: CLOSED status accepted by validation schemas  
- ✅ **Checkbox mapping**: CLOSED correctly maps to "!" checkbox
- ✅ **File persistence**: Status changes saved to tasks.md correctly
- ✅ **Bidirectional updates**: TODO `[ ]` ↔ CLOSED `[!]` transitions work
- ✅ **CLI integration**: Commands accept CLOSED status without errors

### Demonstration

Task #207 itself demonstrates the functionality:
```markdown
- [!] Add CLOSED task status for irrelevant tasks [#207](process/tasks/207-add-closed-task-status-for-irrelevant-tasks.md)
```

## Breaking Changes

None. This is a purely additive feature that doesn't affect existing functionality.

## Migration Guide

No migration required. Existing tasks remain unchanged, and the new CLOSED status is available immediately for new status assignments.

## Usage Examples

```bash
# Set a task to CLOSED status
minsky tasks status set 123 CLOSED

# List all closed tasks  
minsky tasks list --status CLOSED

# Interactive status selection now includes CLOSED option
minsky tasks status set 123  # Will prompt with CLOSED as an option
```

## Future Considerations

- **Task archival workflows**: CLOSED status enables automated archival processes
- **Reporting and analytics**: Distinguish between completed and irrelevant tasks
- **Project lifecycle management**: Better task state management for long-running projects

## Task Completion

This PR fully satisfies **Task #207** requirements:

- ✅ CLOSED status implemented with "!" checkbox representation
- ✅ CLI integration for status setting and filtering  
- ✅ Backend compatibility across all supported backends
- ✅ Proper color coding and visual distinction
- ✅ Documentation and testing completed
- ✅ Critical bug fix ensuring status updates actually work

**Result**: CLOSED status feature is fully operational and ready for production use.
