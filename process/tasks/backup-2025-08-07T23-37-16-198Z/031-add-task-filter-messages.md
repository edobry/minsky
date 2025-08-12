# Add Filter Messages to `tasks list` Command

## Context

Currently, when using the `minsky tasks list` command with filters like `--status` or `--all`, there's no clear indication in the output that filtering is being applied. This can lead to confusion about why certain tasks are or aren't being shown. Adding clear messages about active filters will help users better understand the command's output.

## Requirements

1. **Filter Status Messages**

   - Add informative messages when filters are applied to the task list output
   - Messages should be shown before the task list
   - Messages should be clear and concise
   - Messages should not be shown in JSON output mode

2. **Filter Types to Cover**

   - Status filter (`--status <status>`)
   - Done task visibility (`--all` flag)
   - Any future filters that may be added

3. **Message Format**
   - Messages should be consistent in style
   - Messages should clearly indicate what filtering is being applied
   - Messages should use appropriate formatting (e.g., status in quotes)

## Implementation Steps

1. [x] Update the `tasks list` command:

   - [x] Add message output for status filter
   - [x] Add message output for done task visibility
   - [x] Ensure messages are not shown in JSON mode
   - [x] Add tests for message output

2. [x] Add filter message utility:

   - [x] Create utility function for generating filter messages
   - [x] Support multiple concurrent filters
   - [x] Make messages easily extensible for future filters

3. [x] Update tests:

   - [x] Add tests for filter message output
   - [x] Verify messages are correct for each filter type
   - [x] Verify messages are not shown in JSON mode
   - [x] Test combinations of multiple filters

4. [x] Update documentation:
   - [x] Document new message output in help text
   - [x] Update README if necessary
   - [x] Update changelog

## Example Messages

```
# When using --status
Showing tasks with status 'IN-PROGRESS'
Tasks:
- #003: Third Task [IN-PROGRESS]

# When not using --all (default)
Showing active tasks (use --all to include completed tasks)
Tasks:
- #001: First Task [TODO]
- #003: Third Task [IN-PROGRESS]
```

## Verification

- [x] Running `minsky tasks list --status IN-PROGRESS` shows a clear message about the status filter
- [x] Running `minsky tasks list` (without `--all`) shows a message about hidden completed tasks
- [x] Running `minsky tasks list --json` does not show any filter messages
- [x] Messages are clear and help users understand why they're seeing specific tasks
- [x] All tests pass
- [x] Documentation is updated
- [x] Changelog is updated with a reference to this task spec

## Work Log

- 2023-10-09: Created filter message utility in a new file `src/utils/filter-messages.ts`
- 2023-10-09: Updated `tasks list` command to display filter messages in non-JSON mode
- 2023-10-09: Added tests for filter message utilities
- 2023-10-09: Updated CLI tests to verify filter message display in different scenarios
- 2023-10-09: Updated CHANGELOG.md with new feature details
