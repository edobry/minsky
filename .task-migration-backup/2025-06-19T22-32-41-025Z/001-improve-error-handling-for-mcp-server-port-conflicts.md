# Task #001: Improve Error Handling for MCP Server Port Conflicts

## Context

The Minsky MCP server currently produces excessively verbose and repetitive error messages when it fails to start due to port conflicts (EADDRINUSE). This creates a poor user experience as users have to wade through a stack trace to understand the simple issue that the port is already in use. The error output includes multiple repeated stack traces and raw error objects that don't provide actionable information.

A more user-friendly approach would be to detect common error conditions (like port conflicts) and provide clear, concise error messages with suggested actions, while keeping detailed logs for debugging purposes.

## Requirements

1. **Targeted Error Detection**

   - Detect specific network-related errors, particularly EADDRINUSE errors when starting the MCP server
   - Properly identify other common server startup errors (e.g., permission issues, invalid host)

2. **User-Friendly Error Messages**

   - Provide clear, concise error messages that explain the problem in plain language
   - Include suggestions for how to resolve the issue
   - Remove redundant stack traces from user-facing output

3. **Suggested Actions**

   - For port conflicts (EADDRINUSE), suggest:
     - Using a different port
     - Checking for other running services
     - Commands to find what's using the port (e.g., lsof)

4. **Error Handling Structure**

   - Create a dedicated error handler for network-related errors in the MCP server
   - Integrate with the existing error handling framework
   - Maintain detailed logging for debugging while simplifying user-facing output

5. **Testing**
   - Add tests to verify the improved error handling works correctly
   - Include tests for different error scenarios (port in use, permission issues, etc.)

## Implementation Steps

1. [ ] Analyze the current error handling pipeline in the MCP server:

   - [ ] Identify where errors are caught and processed
   - [ ] Understand the flow from low-level network errors to user output

2. [ ] Create specific error detection:

   - [ ] Add detection for EADDRINUSE errors
   - [ ] Add detection for other common network errors
   - [ ] Ensure error type information is preserved

3. [ ] Implement user-friendly error messages:

   - [ ] Create a mapping from error codes to user-friendly messages
   - [ ] Add suggested actions for each error type
   - [ ] Format messages consistently

4. [ ] Modify existing error handlers:

   - [ ] Update the catch block in `src/commands/mcp/index.ts`
   - [ ] Enhance error handling in `src/mcp/server.ts`
   - [ ] Add more specific error handling for network-related errors

5. [ ] Add unit tests:

   - [ ] Mock server startup failures with different error types
   - [ ] Verify correct error messages are produced
   - [ ] Test that the format is user-friendly and helpful

6. [ ] Update documentation:
   - [ ] Document the improved error handling in code comments
   - [ ] Update user-facing documentation as needed

## Verification

- [ ] When starting the MCP server on a port that's in use, a clear, concise error message is shown
- [ ] The error message includes actionable suggestions
- [ ] No redundant stack traces are shown in normal mode (non-debug)
- [ ] All added tests pass
- [ ] Debug logs still contain detailed information about the error
- [ ] The improvement works for all transport types (SSE, HTTP Stream)

## Additional Context

Current error output when port 8080 is in use:

```
uncaughtException: Failed to start server. Is port 8080 in use?
Error
    at serve (unknown)
    at [kRealListen] (node:_http_server:525:41)
    ...
    [many more stack trace lines]
...
[Error repeated multiple times]
```

Desired error output:

```
Error: Port 8080 is already in use.

Suggestions:
- Use a different port: minsky mcp start --sse --port 8081
- Check what process is using port 8080: lsof -i :8080
- Stop the process using port 8080 before retrying

For detailed error information, run with DEBUG=true.
```
