# Task #127: Fix FastMCP Method Registration Issues

## Context

The MCP (Minsky Command Protocol) server uses the FastMCP library to provide JSON-RPC functionality for communicating with various tools. During the implementation of task #124, we added a repository path parameter to the MCP server to provide context to all commands. However, we discovered that the method registration in FastMCP has issues - methods like `tasks.list` couldn't be called despite being properly registered, resulting in "Method not found" errors.

## Description

During the implementation of task #124 (adding repository path parameter to MCP server), we discovered that the FastMCP library has issues with JSON-RPC method registration or invocation. When attempting to call methods like `tasks.list` or even custom debug methods, we consistently received "Method not found" errors, despite correctly implementing the repository path parameter functionality.

This task involves investigating and fixing the method registration issues in the FastMCP library or our integration with it to ensure that MCP commands work correctly.

## Requirements

1. Investigate why method registration in FastMCP is not working properly
2. Fix the issue with JSON-RPC method registration in the MCP server
3. Ensure that common methods like `tasks.list` can be called successfully
4. Add proper error handling for method registration failures
5. Update documentation if necessary
6. Add tests to verify method registration and invocation

## Acceptance Criteria

- JSON-RPC methods can be successfully registered and called
- `tasks.list` and other core MCP methods work correctly
- The `debug.listMethods` utility works and shows all registered methods
- Proper error handling is in place for method registration issues
- Tests verify that methods can be registered and called
- Documentation is updated if changes to the MCP usage are required

## Related Issues

- Task #124: Add Repository Path Parameter to MCP Server (which discovered the issue)

## Notes

The issue appears to be with how FastMCP registers and handles method names. Even our debug utility that tries to access the internal `_tools` property was unsuccessful in listing available methods. This may require deeper investigation into the FastMCP library or creating a more compatible approach to method registration.
