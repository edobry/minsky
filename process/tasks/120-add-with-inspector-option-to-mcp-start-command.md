# Task #120: Add --with-inspector Option to `mcp start` Command

## Context

When using the Minsky MCP server for development and testing, it's often necessary to also run the `@modelcontextprotocol/inspector` server in a separate terminal to inspect and debug MCP interactions. Currently, this requires running two separate commands and managing two terminal windows. Adding a built-in option to launch the inspector alongside the MCP server would streamline the development workflow and improve the debugging experience.

## Requirements

1. **New Command Option**

   - Add a `--with-inspector` flag to the `minsky mcp start` command
   - When the flag is provided, automatically launch the MCP inspector alongside the MCP server
   - The inspector should connect to the running MCP server for seamless integration

2. **Implementation Details**

   - Use Node.js child process spawning (`spawn` from `child_process` module) to launch the inspector
   - Start the inspector with appropriate parameters to connect to the Minsky MCP server
   - Log helpful messages to inform the user about the inspector's status
   - Handle inspector process errors gracefully

3. **Documentation**

   - Update README-MCP.md to document the new `--with-inspector` option
   - Include examples showing how to use the option
   - Explain the benefits of using the inspector for debugging and testing

4. **Error Handling**
   - Handle errors that may occur when launching the inspector process
   - Provide clear error messages if the inspector fails to start
   - Ensure the main MCP server continues running even if the inspector fails

## Implementation Steps

1. [ ] Update the `mcp start` command in `src/commands/mcp/index.ts`:

   - [ ] Add the `--with-inspector` option with appropriate description
   - [ ] Modify the action handler to check for the flag and launch the inspector
   - [ ] Add code to spawn the inspector process when the flag is enabled
   - [ ] Add error handling for inspector process errors

2. [ ] Update README-MCP.md:

   - [ ] Document the new `--with-inspector` option in the "Starting the MCP Server" section
   - [ ] Add an example showing how to use the option
   - [ ] Explain when and why to use the inspector

3. [ ] Test the implementation:
   - [ ] Verify that the MCP server starts correctly with the `--with-inspector` flag
   - [ ] Verify that the inspector launches and connects to the MCP server
   - [ ] Test error scenarios and ensure appropriate error messages

## Verification

- [ ] Running `minsky mcp start --with-inspector` successfully:
  - Starts the MCP server
  - Launches the MCP inspector
  - The inspector connects to the MCP server
- [ ] The inspector opens in a browser window or provides a URL
- [ ] Error handling works correctly if issues occur
- [ ] Documentation is updated to reflect the new option

## Example Output

```bash
$ minsky mcp start --with-inspector
Minsky MCP Server started with stdio transport
MCP Inspector started. A browser window should open automatically.
If it doesn't, you can access it at http://localhost:6274
Press Ctrl+C to stop
```
