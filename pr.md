# feat(#282): Port MCP server from FastMCP to official MCP SDK

## Summary

Successfully migrated Minsky's MCP server from the proprietary FastMCP library to the official `@modelcontextprotocol/sdk`, resolving compatibility issues with standard MCP clients like Claude Desktop.

## Problem Addressed

FastMCP expected proprietary `~standard.vendor` metadata that standard MCP clients don't provide, causing compatibility failures. The official MCP SDK ensures full compliance with the MCP protocol specification.

## Changes

### Removed
- FastMCP dependency completely eliminated
- Proprietary FastMCP-specific configurations and handlers
- Custom FastMCP transport implementations

### Added
- `@modelcontextprotocol/sdk` dependency
- `zod-to-json-schema` for proper schema conversion
- Official MCP Server class and StdioServerTransport
- Proper JSON-RPC 2.0 request/response handling
- Standard MCP protocol compliance

### Modified
- **src/mcp/server.ts**: Complete rewrite using official SDK
  - Replaced FastMCP server with `Server` from `@modelcontextprotocol/sdk`
  - Implemented proper `ListToolsRequestSchema` and `CallToolRequestSchema` handlers
  - Added tool/resource/prompt management with Maps
  - Uses `StdioServerTransport` for standard I/O communication

- **src/mcp/command-mapper.ts**: Updated for official SDK
  - Changed from FastMCP `ToolDefinition` to official SDK tool registration
  - Added JSON Schema conversion from Zod schemas using `zod-to-json-schema`
  - Maintains all 46+ tool registrations

- **src/commands/mcp/index.ts**: Simplified transport layer
  - Removed FastMCP-specific network configuration
  - Focus on stdio transport only for Claude Desktop compatibility
  - Simplified error handling for cleaner user experience

- **package.json**: Updated dependencies
  - Removed: `fastmcp`
  - Added: `@modelcontextprotocol/sdk`, `zod-to-json-schema`

## Testing Performed

### Unit Tests
- ✅ All MCP-specific tests pass (6/6)
- ✅ Server initialization tests updated for official SDK
- ✅ Command mapper tests verify proper tool registration

### Integration Testing
- ✅ **End-to-end MCP protocol verification**
  - Tested actual JSON-RPC 2.0 communication via stdin/stdout
  - Verified `initialize` request returns proper capabilities
  - Confirmed `tools/list` exposes all 46+ registered tools
  - Tested `tools/call` request handling works correctly

### Compatibility Verification
- ✅ Server starts without FastMCP dependency errors
- ✅ Compatible with Claude Desktop and standard MCP clients
- ✅ All existing CLI functionality maintained (`minsky mcp start`, `minsky mcp --help`)

## Performance Impact

- **Improved startup time**: No more FastMCP initialization overhead
- **Better error handling**: Standard MCP protocol error responses
- **Reduced bundle size**: Official SDK is more focused than FastMCP

## Acceptance Criteria

- [x] Remove fastmcp dependency completely
- [x] Install @modelcontextprotocol/sdk 
- [x] Rewrite server.ts using official SDK Server class and StdioServerTransport
- [x] Update command-mapper.ts for official SDK tool registration
- [x] Simplify transport layer to focus on stdio only
- [x] Test integration and compatibility with Claude Desktop
- [x] Maintain all existing CLI functionality
- [x] All tests pass (MCP-specific tests: 6/6 ✅)

## Migration Notes

This change resolves the core issue preventing standard MCP clients from communicating with Minsky. The official SDK ensures full MCP protocol specification compliance, eliminating the `~standard.vendor` metadata requirement that was breaking compatibility.

No breaking changes to the CLI interface - all `minsky mcp` commands work exactly as before, but now with proper standard MCP client support. 
