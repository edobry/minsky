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

## Implementation Plan

### 1. Install Inspector Dependencies

1. Add the `@modelcontextprotocol/inspector` as a dev dependency to the project
2. Ensure the inspector is compatible with the current version of `fastmcp` (currently v1.27.4)

### 2. Update MCP Start Command

1. Modify `src/commands/mcp/index.ts` to:
   - Add the `--with-inspector` option to the start command with appropriate description
   - Add an optional `--inspector-port` option with a default value (e.g., 6274)
   - Update the action handler to check for the flag and launch the inspector

### 3. Create Inspector Launcher Module

1. Create a new module `src/mcp/inspector-launcher.ts` that will:
   - Export a function to launch the inspector
   - Handle the spawning of the child process
   - Configure the inspector to connect to the MCP server
   - Set up error handling for the inspector process
   - Provide helper functions to determine if the inspector is available

### 4. Implement Error Handling

1. Add robust error handling that:
   - Catches and logs inspector startup failures
   - Provides clear user messages when the inspector fails
   - Ensures the MCP server continues running even if the inspector fails
   - Adds debug logging for troubleshooting

### 5. Update Documentation

1. Update `README-MCP.md` to:
   - Document the new `--with-inspector` and `--inspector-port` options
   - Add examples showing how to use the options
   - Explain the benefits of using the inspector for debugging
   - Include a new section on debugging with the inspector

### 6. Testing

1. Create manual test scenarios:
   - Test starting the server with `--with-inspector`
   - Test with different transport options (stdio, SSE, HTTP Stream)
   - Test error handling when the inspector fails to start
   - Test that the server continues running if the inspector is closed

## Implementation Steps

1. [x] Install the MCP inspector package as a dev dependency:

   ```
   bun add -d @modelcontextprotocol/inspector
   ```

2. [x] Update the `mcp start` command in `src/commands/mcp/index.ts`:

   - [x] Add the `--with-inspector` option with appropriate description
   - [x] Add the optional `--inspector-port` option with a default value
   - [x] Modify the action handler to check for the flag and launch the inspector
   - [x] Add code to spawn the inspector process when the flag is enabled
   - [x] Add error handling for inspector process errors

3. [x] Create a new file `src/mcp/inspector-launcher.ts`:

   - [x] Implement the inspector launcher function
   - [x] Set up proper error handling and logging
   - [x] Configure the inspector to connect to the MCP server

4. [x] Update README-MCP.md:

   - [x] Document the new `--with-inspector` option in the "Starting the MCP Server" section
   - [x] Add the optional `--inspector-port` option documentation
   - [x] Add examples showing how to use the options
   - [x] Explain when and why to use the inspector
   - [x] Add a new section about debugging with the inspector

5. [x] Test the implementation:
   - [x] Verify that the MCP server starts correctly with the `--with-inspector` flag
   - [x] Verify that the inspector launches and connects to the MCP server
   - [x] Test different transport options
   - [x] Test error scenarios and ensure appropriate error messages

## Verification

- [x] Running `minsky mcp start --with-inspector` successfully:
  - Starts the MCP server
  - Launches the MCP inspector
  - The inspector connects to the MCP server
- [x] The inspector opens in a browser window or provides a URL
- [x] Using `--inspector-port` allows specifying a custom port
- [x] Error handling works correctly if issues occur
- [x] Documentation is updated to reflect the new options

## Example Output

```bash
$ minsky mcp start --with-inspector
Minsky MCP Server started with stdio transport
MCP Inspector started on port 6274
Open your browser at http://localhost:6274 to access the inspector
Press Ctrl+C to stop
```
