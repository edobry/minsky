This PR implements the enhanced session PR command with support for reading body content from files.

## Changes

### Added
- --body-path parameter to read PR body content from a file
- Required title parameter with minimum length validation
- Validation to require either body or bodyPath parameter
- Comprehensive file reading with error handling for missing files, empty files, and permission errors

### Enhanced
- Updated sessionPrFromParams function to handle file reading
- Added proper error handling with specific ValidationError messages
- Session PR command now validates required parameters

### Fixed
- Bug where bodyPath content wasn't being passed to preparePrFromParams
- Ensured file content is properly read and used in commit messages

### Testing
- Added comprehensive unit tests covering new functionality
- Tests for file reading, error scenarios, and parameter validation
- Manual verification of end-to-end functionality

## Technical Details

- File paths support both relative and absolute paths
- Direct body parameter takes priority over bodyPath when both provided
- Graceful error handling for file operations
- Backward compatible where possible (only title becomes required)

This enhancement improves the PR workflow by allowing users to maintain PR body content in files while ensuring all PRs have proper titles and descriptions.

## Acceptance Criteria Verification

- [x] `--body-path` option is added to `session pr` command
- [x] Command reads file content when `--body-path` is provided
- [x] Title parameter is required
- [x] Either `--body` or `--body-path` is required
- [x] Clear validation errors for missing required parameters
- [x] File read errors are handled gracefully
- [x] Both relative and absolute file paths work correctly
- [x] Unit tests cover new functionality and edge cases
- [x] Bug fix for undefined body content in commit messages
