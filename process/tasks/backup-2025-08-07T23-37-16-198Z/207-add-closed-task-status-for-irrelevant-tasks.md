# Add CLOSED task status for irrelevant tasks

## Status

BACKLOG

## Priority

MEDIUM

## Description

Add a CLOSED status option to mark tasks as no longer relevant or cancelled, distinct from DONE which indicates completion. This allows preserving task history while clearly indicating the task should not be worked on.

## Context

The current task system supports TODO, IN-PROGRESS, IN-REVIEW, DONE, and BLOCKED statuses. However, there's no way to mark tasks as CLOSED when they become irrelevant, obsolete, or are cancelled. This is different from DONE (which indicates successful completion) - CLOSED indicates the task is no longer relevant but should be preserved for historical context.

## Requirements

### Core Status Support

- [ ] Add "CLOSED" as a valid task status alongside existing statuses
- [ ] Update task status validation to include CLOSED
- [ ] Ensure CLOSED tasks are handled correctly in task filtering and display
- [ ] Add CLOSED status to CLI status selection prompts
- [ ] Define appropriate checkbox representation for CLOSED status (suggest "!" or "×")

### Status Management

- [ ] Update TaskStatus type definition to include CLOSED
- [ ] Modify task status validation functions in `src/domain/tasks/taskConstants.ts`
- [ ] Update status setting commands to accept CLOSED
- [ ] Ensure status transitions work correctly (any status → CLOSED)
- [ ] Add CLOSED to `TASK_STATUS_CHECKBOX` and `CHECKBOX_TO_STATUS` mappings

### CLI Integration

- [ ] Add CLOSED to `minsky tasks status set` command options
- [ ] Update task listing to properly display CLOSED status
- [ ] Add filtering support for CLOSED tasks (e.g., `minsky tasks list --status CLOSED`)
- [ ] Update status prompts to include CLOSED option
- [ ] Consider excluding CLOSED tasks from default task listings (similar to how DONE tasks might be handled)

### Backend Compatibility

- [ ] Ensure all task backends (markdown, json-file, github-issues) support CLOSED status
- [ ] Update status mapping in `src/domain/tasks/githubIssuesTaskBackend.ts`
- [ ] Update status mapping in `src/domain/tasks/migrationUtils.ts`
- [ ] Verify CLOSED status persists correctly across backend operations
- [ ] Add appropriate GitHub label mapping for CLOSED status

### UI/UX Considerations

- [ ] Choose appropriate visual representation for CLOSED tasks
- [ ] Add color coding for CLOSED status in GitHub backend (suggest gray or red)
- [ ] Ensure CLOSED tasks are visually distinct from DONE tasks
- [ ] Consider adding confirmation prompt when closing tasks

### Documentation and Testing

- [ ] Update task status documentation
- [ ] Add tests for CLOSED status functionality
- [ ] Verify status transitions and validation
- [ ] Test CLI commands with CLOSED status
- [ ] Update help text and examples

## Implementation Details

### Files to Update

1. **Core Constants**

   - `src/domain/tasks/taskConstants.ts` - Add CLOSED to TASK_STATUS enum and mappings
   - `src/schemas/tasks.ts` - Update task status schema validation

2. **CLI Commands**

   - `src/adapters/shared/commands/tasks.ts` - Add CLOSED to status options
   - `src/adapters/shared/commands/__tests__/tasks-status-selector.test.ts` - Update tests

3. **Backend Support**

   - `src/domain/tasks/githubIssuesTaskBackend.ts` - Add CLOSED label mapping
   - `src/domain/tasks/migrationUtils.ts` - Add CLOSED status mapping
   - `src/domain/tasks/githubBackendConfig.ts` - Add color for CLOSED status

4. **MCP Integration**

   - `src/mcp/tools/tasks.ts` - Update status enum for MCP tools

5. **Type Definitions**
   - Update any TypeScript type definitions that reference task statuses

### Suggested Checkbox Representation

- Consider using "!" for CLOSED status (visually distinct from "x" for DONE)
- Alternative: "×" (multiplication symbol) to differentiate from "x"

### Status Transition Rules

- Any status can transition to CLOSED
- CLOSED tasks can potentially be reopened to TODO or other statuses
- Consider whether CLOSED tasks should be included in default listings

## Success Criteria

- [ ] CLOSED status is available in all CLI commands (`minsky tasks status set`)
- [ ] CLOSED tasks are properly displayed in task listings
- [ ] CLOSED status persists correctly across all backend types
- [ ] Status filtering works correctly for CLOSED tasks
- [ ] All existing tests pass
- [ ] New tests validate CLOSED status functionality
- [ ] Documentation is updated to reflect new status option
- [ ] GitHub backend properly handles CLOSED status with appropriate labels/colors
- [ ] Checkbox representation is properly parsed and displayed
- [ ] Status transitions work correctly (any → CLOSED)

## Acceptance Tests

1. **CLI Operations**

   ```bash
   # Create and close a task
   minsky tasks create --title "Test task"
   minsky tasks status set <task-id> CLOSED

   # Verify filtering
   minsky tasks list --status CLOSED
   ```

2. **Backend Persistence**

   - Set task to CLOSED status
   - Verify status persists after restart
   - Verify status appears correctly in backend storage

3. **Status Transitions**
   - Test transitioning from each status to CLOSED
   - Test reopening CLOSED tasks to other statuses

## Related Work

- See task #155 which added BLOCKED status support for similar implementation patterns
- Review existing status management in `src/domain/tasks/taskConstants.ts`
