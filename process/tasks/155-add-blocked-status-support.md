# Add BLOCKED Status Support

## Summary

Add support for BLOCKED status in the task management system to properly handle tasks that are waiting on dependencies or external factors.

## Context

Currently, the task system supports TODO, IN-PROGRESS, IN-REVIEW, and DONE statuses. However, there's no way to mark tasks as BLOCKED when they're waiting on dependencies (like task 154 waiting for task 141). This status is mentioned in task specifications but not implemented in the system.

## Requirements

### Core Status Support

- [ ] Add "BLOCKED" as a valid task status alongside existing statuses
- [ ] Update task status validation to include BLOCKED
- [ ] Ensure BLOCKED tasks are handled correctly in task filtering and display
- [ ] Add BLOCKED status to CLI status selection prompts

### Status Management

- [ ] Update TaskState type definition to include BLOCKED
- [ ] Modify task status validation functions
- [ ] Update status setting commands to accept BLOCKED
- [ ] Ensure status transitions work correctly (e.g., BLOCKED → IN-PROGRESS)

### CLI Integration

- [ ] Add BLOCKED to `minsky tasks status set` command options
- [ ] Update task listing to properly display BLOCKED status
- [ ] Add filtering support for BLOCKED tasks (e.g., `minsky tasks list --status BLOCKED`)
- [ ] Update status prompts to include BLOCKED option

### Backend Compatibility

- [ ] Ensure all task backends (markdown, json-file, github-issues) support BLOCKED status
- [ ] Update status mapping in backends where needed
- [ ] Verify BLOCKED status persists correctly across backend operations

### Documentation and Testing

- [ ] Update task status documentation
- [ ] Add tests for BLOCKED status functionality
- [ ] Verify status transitions and validation
- [ ] Test CLI commands with BLOCKED status

## Implementation Details

### Files to Update

1. **Type Definitions**

   - `src/types/tasks/taskData.ts` - Add BLOCKED to TaskState
   - Update any status validation schemas

2. **Task Functions**

   - `src/domain/tasks/taskFunctions.ts` - Update status validation
   - Ensure status transition logic handles BLOCKED

3. **CLI Commands**

   - `src/adapters/shared/commands/tasks.ts` - Update status parameters
   - Add BLOCKED to status selection options

4. **Backend Implementations**
   - Verify all backends handle BLOCKED status correctly
   - Update any status mapping logic

### Status Semantics

**BLOCKED** should be used when:

- Task is waiting on completion of another task (dependencies)
- Task is waiting on external factors (approvals, resources, etc.)
- Task cannot proceed due to blockers outside the implementer's control

**BLOCKED** tasks should:

- Be clearly visible in task listings
- Support filtering and querying
- Allow transition to other statuses when blockers are resolved
- Maintain proper audit trail of status changes

## Acceptance Criteria

- [ ] BLOCKED is accepted as a valid status in all CLI commands
- [ ] `minsky tasks status set <id> BLOCKED` works correctly
- [ ] `minsky tasks list --status BLOCKED` shows only blocked tasks
- [ ] Task status prompts include BLOCKED option
- [ ] All task backends persist BLOCKED status correctly
- [ ] Tests verify BLOCKED status functionality
- [ ] Documentation is updated

## Testing

### Manual Testing

```bash
# Set a task to BLOCKED status
minsky tasks status set 154 BLOCKED

# List blocked tasks
minsky tasks list --status BLOCKED

# Verify status is persisted
minsky tasks status get 154
```

### Automated Testing

- Unit tests for status validation with BLOCKED
- Integration tests for CLI commands with BLOCKED status
- Backend tests for BLOCKED status persistence

## Priority

Medium - This is needed for proper task dependency management and makes the task system more complete.

## Dependencies

None - This is a straightforward addition to existing status management functionality.
