# feat(#126): Add Task Specification Content Reading Capability

## Summary

This PR adds a new `spec` subcommand to the `tasks` command that allows users to read the full content of a task's specification file directly from the CLI. The feature also supports retrieving specific sections of the spec by name.

## Changes

### Added

- New `TaskService.getTaskSpecContent` method to retrieve task specification content
- New `getTaskSpecContentFromParams` domain function for interface-agnostic command architecture
- New `taskSpecContentParamsSchema` Zod schema for validating command parameters
- New `TaskSpecContentParams` type for type safety
- CLI adapter implementation with `tasks spec` command
- Support for optional `--section` parameter to extract specific sections of the spec file

### Changed

- Updated exports in domain layer to include the new functionality

## Testing

The implementation has been manually tested to verify:

- Retrieving full specification content for a task
- Extracting specific sections from a specification
- Proper error handling for invalid task IDs or missing specs

## Checklist

- [x] All requirements implemented
- [x] Code follows project patterns and conventions
- [x] Documentation is clear and complete
- [x] Implementation is compatible with the existing codebase
