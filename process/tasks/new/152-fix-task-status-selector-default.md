# Task #152: Fix Task Status Selector to Show Current Status as Default

## Priority

HIGH

## Description

When using `minsky tasks status set <task-id>` on a task that already has a status, the interactive selector should pre-select the current status instead of defaulting to TODO.

## Problem

Currently, if a task has status DONE and you run `minsky tasks status set 151`, the interactive selector shows:

```
◆  Select a status:
│  ● TODO          <- This should not be selected
│  ○ IN-PROGRESS
│  ○ IN-REVIEW
│  ○ DONE          <- This should be selected since it's the current status
│  ○ BLOCKED
```

## Expected Behavior

The status selector should pre-select the current status of the task:

```
◆  Select a status:
│  ○ TODO
│  ○ IN-PROGRESS
│  ○ IN-REVIEW
│  ● DONE          <- Current status should be pre-selected
│  ○ BLOCKED
```

## Acceptance Criteria

1. When running `minsky tasks status set <task-id>` on an existing task, the interactive selector should show the current task status as the default/selected option
2. The behavior should work for all task statuses (TODO, IN-PROGRESS, IN-REVIEW, DONE, BLOCKED)
3. New tasks without a status should still default to TODO
4. The fix should not break existing functionality

## Implementation Notes

- The issue likely exists in the CLI interactive prompt logic
- Need to fetch the current task status before showing the selector
- The selector component needs to be configured to pre-select the current status

## Test Cases

1. Create a task and set it to DONE, then run `minsky tasks status set <id>` - should show DONE as selected
2. Create a task and set it to IN-PROGRESS, then run `minsky tasks status set <id>` - should show IN-PROGRESS as selected
3. Create a new task (status TODO), then run `minsky tasks status set <id>` - should show TODO as selected
4. Test with all possible status values

## Related Files

- CLI status command implementation
- Interactive prompt components
- Task status management logic
