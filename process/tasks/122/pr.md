# feat(#122): Improve Error Handling for MCP Server Port Conflicts

## Summary

This PR improves the error handling for network-related errors in the MCP server, particularly for port conflicts (EADDRINUSE). It provides user-friendly error messages with suggested actions while maintaining detailed logging for debugging purposes.

## Changes

### Added

- Added specialized error classes for network errors:
  - `NetworkError`: Base class for all network-related errors
  - `PortInUseError`: Specific class for port-in-use (EADDRINUSE) errors
  - `NetworkPermissionError`: Specific class for permission-related network errors (EACCES)
- Added utility functions for network error handling:
  - `isNetworkError`: Checks if an error is a network error
  - `createNetworkError`: Factory function to create specialized network errors
  - `formatNetworkErrorMessage`: Formats network errors with user-friendly messages and suggestions
- Added comprehensive tests for the new network error handling

### Changed

- Updated the MCP command to use the new network error handling:
  - Now detects network errors and provides user-friendly messages
  - Shows suggestions for resolving port conflicts
  - Only shows stack traces in debug mode
- Improved error handling in the MCP server's start method

## Testing

- Added unit tests for all new network error handling functions and classes
- Manually tested the improved error messages by starting the MCP server on a port that was already in use

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
