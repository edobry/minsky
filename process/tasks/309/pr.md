## Summary

Implements comprehensive semantic error handling for file operations to improve AI agent UX by replacing cryptic filesystem errors with actionable guidance. This includes error classification, auto-directory creation, and structured error responses.

## Changes

### Added

- **Semantic Error Schema**: Added comprehensive typing with error codes, solutions, and related tools
- **Error Classification Utility**: Created utility to convert low-level filesystem errors into semantic errors
- **Auto-Directory Creation**: Added createDirs option (default: true) for session_write_file
- **Integration Tests**: Added tests for real-world filesystem error scenarios

### Updated

- **Session File Operations**: Modified all session file tools to use the semantic error classifier
- **Error Response Format**: Standardized error response format with actionable guidance
- **Error Classification**: Simplified and improved performance by removing filesystem I/O from error paths

## Technical Decisions

- **Pure Heuristic Approach**: Used error codes, message patterns, and operation context for error classification without adding additional I/O operations
- **Default Auto-Creation**: Made createDirs=true the default for better AI agent UX
- **Synchronous Processing**: Made error handling synchronous for better performance

## Testing

- **Unit Tests**: Added tests for all error classification scenarios
- **Integration Tests**: Added tests that validate the end-to-end error handling
- **Manual Tests**: Verified error handling with real-world file operations

## Reviewer Notes

The changes improve AI agent UX by making filesystem errors understandable and actionable. The error messages now provide specific guidance and related tools that can help resolve issues.

Instead of cryptic errors like "ENOENT: no such file or directory", AI agents will see structured errors with solutions like "Parent directory does not exist - set createDirs: true".
