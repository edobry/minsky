# Task #027: Add Filter Messages to `tasks list` Command

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

1. [ ] Update the `tasks list` command:
   - [ ] Add message output for status filter
   - [ ] Add message output for done task visibility
   - [ ] Ensure messages are not shown in JSON mode
   - [ ] Add tests for message output

2. [ ] Add filter message utility:
   - [ ] Create utility function for generating filter messages
   - [ ] Support multiple concurrent filters
   - [ ] Make messages easily extensible for future filters

3. [ ] Update tests:
   - [ ] Add tests for filter message output
   - [ ] Verify messages are correct for each filter type
   - [ ] Verify messages are not shown in JSON mode
   - [ ] Test combinations of multiple filters

4. [ ] Update documentation:
   - [ ] Document new message output in help text
   - [ ] Update README if necessary
   - [ ] Update changelog

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

- [ ] Running `minsky tasks list --status IN-PROGRESS` shows a clear message about the status filter
- [ ] Running `minsky tasks list` (without `--all`) shows a message about hidden completed tasks
- [ ] Running `minsky tasks list --json` does not show any filter messages
- [ ] Messages are clear and help users understand why they're seeing specific tasks
- [ ] All tests pass
- [ ] Documentation is updated
- [ ] Changelog is updated with a reference to this task spec 
