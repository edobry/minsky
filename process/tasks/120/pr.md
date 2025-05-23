# feat(#120): Add --with-inspector Option to `mcp start` Command

## Summary

This PR implements task #120, adding a new option to the `mcp start` command that allows launching the MCP inspector alongside the MCP server. This streamlines the development and debugging workflow by eliminating the need to manually start the inspector in a separate terminal.

## Motivation & Context

When working with the Minsky MCP server during development and testing, it's often necessary to run the MCP inspector for debugging purposes. Previously, this required running two separate commands in different terminal windows and manually connecting them. This change simplifies the workflow by allowing the inspector to be launched automatically with the server.

## Design/Approach

We've implemented a modular approach with a dedicated inspector launcher that handles process management, error handling, and server connection. This allows for clean separation of concerns and makes the codebase more maintainable. The implementation respects existing command patterns and ensures backward compatibility.

## Key Changes

- Added a new `--with-inspector` flag to the `mcp start` command
- Added an optional `--inspector-port` parameter to specify a custom port (default: 6274)
- Created a new module `src/mcp/inspector-launcher.ts` to handle inspector process management
- Implemented robust error handling that ensures MCP server continues to run even if inspector fails
- Added detection for whether the inspector package is installed
- Updated README-MCP.md with comprehensive documentation for the new options
- Added a "Debugging with the MCP Inspector" section to README-MCP.md with usage examples

## Testing

- Tested launching the inspector with the default stdio transport
- Verified inspector launching works with different transport options (SSE, HTTP Stream)
- Tested error handling when the inspector fails to start
- Verified the MCP server continues to run even if the inspector process is terminated
- Confirmed the inspector correctly connects to the MCP server

## Breaking Changes

None. All changes are backward compatible and existing commands continue to function as before.

## Stats

CHANGELOG.md | 10 +
README-MCP.md | 42 ++++
bun.lock | 247 ++++++++++++++++++++-
package.json | 1 +
...d-with-inspector-option-to-mcp-start-command.md | 102 +++++++--
src/commands/mcp/index.ts | 38 +++-
src/mcp/inspector-launcher.ts | 164 ++++++++++++++
7 files changed, 576 insertions(+), 28 deletions(-)

## Uncommitted changes in working directory

process/tasks/120/pr.md

Task #120 status updated: TODO → IN-REVIEW
