# Task #125: Implement CLI Bridge for Shared Command Registry

## Context

Currently, Minsky had two parallel implementations for commands:

1. **Shared Command Registry**: Defines commands, parameters, and execution logic in an interface-agnostic way, making them available to the MCP interface.
2. **CLI Adapters**: Manually created Commander.js commands that mapped to the shared command implementations.

This created duplication of effort and potential inconsistencies. This task resolves that by implementing a CLI bridge that auto-generates Commander.js commands from the shared registry.

## Problem Statement

The previous architecture required developers to:

- Define a command in the shared command registry
- Separately create a CLI adapter implementation
- Maintain both implementations when changes were needed

This duplicated effort and created opportunity for inconsistencies between interfaces.

## Solution & Summary

- **CLI Bridge Implemented:** A CLI bridge now automatically generates Commander.js commands from shared command registry entries.
- **Parameter Mapping:** All parameter types (string, number, boolean, arrays, etc.) are mapped, with required/optional handling and help text generation.
- **Output Handling:** Consistent output formatting, error handling, and JSON output mode are supported.
- **Migration:** The 'tasks spec' command and all session commands have been migrated to use the bridge. Manual CLI adapter code is being phased out.
- **Documentation:** Developer documentation and migration guidance are provided.

## Implementation Steps (All Complete)

- [x] Research and analyze current CLI adapter patterns
- [x] Design the CLI bridge architecture
- [x] Implement core CLI bridge functionality
- [x] Create a prototype using an existing command
- [x] Expand implementation to support all parameter types
- [x] Implement error handling and output formatting
- [x] Create migration tools and documentation
- [x] Migrate selected commands to use the bridge (including 'tasks spec')
- [x] Add tests
- [x] Update documentation

## Verification (All Complete)

- [x] Bridge successfully generates CLI commands from shared registry entries
- [x] Bridge-generated commands have the same functionality as manually created ones
- [x] All parameter types are correctly mapped to CLI options
- [x] Help text is properly generated with accurate descriptions
- [x] Output formatting is consistent with existing CLI commands
- [x] Error handling works correctly with appropriate exit codes
- [x] JSON output mode functions correctly
- [x] Test coverage is comprehensive for bridge functionality
- [x] Documentation is complete and provides clear migration guidance
- [x] A set of commands (including 'tasks spec') has been successfully migrated to use the bridge

## References

- See PR: process/tasks/125/pr.md
- See Changelog: /Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#125/CHANGELOG.md
- _See: SpecStory history [2023-05-29_cli-bridge-implementation](mdc:.specstory/history/2023-05-29_cli-bridge-implementation.md) for implementation details._
