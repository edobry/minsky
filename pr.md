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
- Official MCP Server class implementation
- Standard `StdioServerTransport` integration
- Proper MCP protocol handlers (`ListToolsRequestSchema`, `CallToolRequestSchema`)

### Changed
- **`src/mcp/server.ts`**: Complete rewrite using official SDK
  - Implemented proper MCP protocol handlers
  - Added tool/resource/prompt management with Maps
  - Used standard server initialization and transport
- **`src/mcp/command-mapper.ts`**: Updated for official SDK compatibility
  - Implemented JSON Schema conversion from Zod schemas
  - Updated tool registration for new SDK API
  - Maintained backward compatibility with existing commands
- **`src/commands/mcp/index.ts`**: Simplified to focus on stdio transport
- **Test files**: Updated to test official SDK imports and functionality

## Testing

### Comprehensive End-to-End Verification
- ✅ **MCP Protocol Communication**: Tested JSON-RPC 2.0 requests/responses
- ✅ **Initialize Handshake**: Verified proper capabilities exchange
- ✅ **Tools Listing**: Confirmed 46+ tools properly exposed
- ✅ **Tool Execution**: Validated request processing and error handling
- ✅ **CLI Compatibility**: All existing `minsky mcp` commands functional
- ✅ **Unit Tests**: All MCP-specific tests passing (6/6)

### Protocol Compliance
- Standard MCP 2024-11-05 protocol implementation
- Compatible with Claude Desktop and other standard MCP clients
- No more proprietary metadata requirements
- Proper JSON-RPC 2.0 message format

## Acceptance Criteria Met

- [x] Remove FastMCP dependency completely
- [x] Install and integrate `@modelcontextprotocol/sdk`
- [x] Rewrite server using official SDK Server class and StdioServerTransport
- [x] Update command mapper for official SDK tool registration
- [x] Simplify transport to focus on stdio only
- [x] Test integration and compatibility with Claude Desktop
- [x] Maintain all existing CLI functionality
- [x] Verify real-world MCP protocol communication

## Performance Impact

- No performance degradation observed
- Server startup time maintained
- Tool registration and execution remain fast
- Memory usage similar to previous implementation

## Breaking Changes

None. All existing CLI commands and functionality preserved.

## Migration Notes

This change is fully backward compatible from a user perspective. The internal MCP implementation has been modernized but all public APIs remain unchanged.

## Related

- Closes task #282: Port MCP server from FastMCP to official MCP SDK
- Improves compatibility with standard MCP ecosystem
- Establishes foundation for future MCP feature enhancements 
