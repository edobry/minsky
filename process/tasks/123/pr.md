# feat(#123): Enhance `tasks get` Command to Support Multiple Task IDs

## Summary

This PR enhances the `tasks get` command to support retrieving information for multiple tasks in a single operation. This allows users to easily understand a task in the context of other related tasks.

## Changes

### Added

- Support for retrieving multiple tasks in a single command using two different syntaxes:
  - Comma-separated list: `minsky tasks get 001,002,003`
  - Multiple arguments: `minsky tasks get 001 002 003`
- Enhanced task schemas to handle arrays of task IDs
- Updated CLI adapter to handle both single and multiple task retrieval
- Updated MCP adapter to support multiple task requests
- Improved output formatting to clearly display multiple task information with separators

### Changed

- Refactored `getTaskFromParams` function to support both single and multiple task IDs
- Added helper functions for handling single and multiple task retrieval
- Enhanced error handling to continue processing valid task IDs when some are invalid
- Updated command argument from required `<task-id>` to optional `[task-ids...]`

## Testing

The implementation was manually tested with the following scenarios:

- Single task retrieval (backward compatibility)
- Multiple task retrieval using comma-separated syntax
- Multiple task retrieval using multiple arguments syntax
- Error handling for mixed valid/invalid IDs
- JSON output format for multiple tasks

## Checklist

- [x] All requirements implemented
- [x] Code quality is acceptable
- [x] Documentation is updated (CHANGELOG.md)
- [x] Backwards compatibility maintained
