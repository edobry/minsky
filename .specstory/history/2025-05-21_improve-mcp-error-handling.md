# SpecStory: Improve MCP Error Handling

## Conversation Summary

The user encountered a verbose and repetitive error message when trying to start the MCP server on a port that was already in use. The error output included multiple stack traces and raw error objects that didn't provide actionable information, making it difficult to understand the simple issue that the port was already in use.

We created a task to improve the error handling in the MCP server, specifically targeting common network-related errors like port conflicts (EADDRINUSE). The task focuses on providing user-friendly error messages with suggested actions, while maintaining detailed logs for debugging purposes.

## Key Decisions

1. **Focus on Common Network Errors**: Prioritize improving error messages for common scenarios like port conflicts (EADDRINUSE), rather than attempting to handle every possible error condition.

2. **User-Friendly Output**: Structure the error messages to be clear and concise, with actionable suggestions for resolving the issue.

3. **Keep Detailed Logs for Debugging**: Maintain comprehensive error logging for debugging purposes while simplifying the user-facing output.

4. **Integrate with Existing Error Framework**: Build on the existing error handling framework rather than creating a completely new system.

## Implementation Plan

1. Analyze the current error handling pipeline to understand where network errors are caught and processed.

2. Add specific detection for EADDRINUSE and other common network errors, preserving error type information.

3. Create user-friendly error messages with suggested actions for each error type.

4. Modify existing error handlers in the MCP server to use these improved messages.

5. Add tests to verify the improved error handling works correctly.

6. Update documentation as needed.

## Original Error Output

```
uncaughtException: Failed to start server. Is port 8080 in use?
Error
    at serve (unknown)
    at [kRealListen] (node:_http_server:525:41)
    at listen (node:_http_server:502:35)
    at <anonymous> (/Users/edobry/Projects/minsky/node_modules/mcp-proxy/dist/chunk-FMSNG7MS.js:443:16)
    at Promise (unknown:1:11)
    at <anonymous> (/Users/edobry/Projects/minsky/node_modules/mcp-proxy/dist/chunk-FMSNG7MS.js:442:13)
    at startSSEServer (/Users/edobry/Projects/minsky/node_modules/mcp-proxy/dist/chunk-FMSNG7MS.js:344:22)
    at start (/Users/edobry/Projects/minsky/node_modules/fastmcp/dist/FastMCP.js:882:31)
    at start (/Users/edobry/Projects/minsky/node_modules/fastmcp/dist/FastMCP.js:860:15)
    at start (/Users/edobry/Projects/minsky/src/mcp/server.ts:140:27)
    at start (/Users/edobry/Projects/minsky/src/mcp/server.ts:131:32)
    at <anonymous> (/Users/edobry/Projects/minsky/src/commands/mcp/index.ts:73:22)
    at <anonymous> (/Users/edobry/Projects/minsky/src/commands/mcp/index.ts:30:20)
    at _parseCommand (/Users/edobry/Projects/minsky/node_modules/commander/lib/command.js:1585:27)
    at _dispatchSubcommand (/Users/edobry/Projects/minsky/node_modules/commander/lib/command.js:1345:25)
    at _dispatchSubcommand (/Users/edobry/Projects/minsky/node_modules/commander/lib/command.js:1345:25)
    at parse (/Users/edobry/Projects/minsky/node_modules/commander/lib/command.js:1075:10)
    at /Users/edobry/Projects/minsky/src/cli.ts:37:9
    at moduleEvaluation (unknown:1:11)
    at moduleEvaluation (unknown:1:11)
    at loadAndEvaluateModule (unknown:2)
    at processTicksAndRejections (unknown:7:39)
```

The error is repeated multiple times in the output, making it difficult to understand the actual issue.

## Desired Error Output

```
Error: Port 8080 is already in use.

Suggestions:
- Use a different port: minsky mcp start --sse --port 8081
- Check what process is using port 8080: lsof -i :8080
- Stop the process using port 8080 before retrying

For detailed error information, run with DEBUG=true.
```

This more user-friendly output clearly explains the problem and provides actionable suggestions for resolving it.

## Next Steps

1. Implement the task as described in the specification.
2. Add tests to verify the improved error handling.
3. Document the changes in code comments and user-facing documentation.
4. Update this SpecStory file with the final implementation details once completed.
