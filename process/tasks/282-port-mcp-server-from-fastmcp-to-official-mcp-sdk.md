# Task #282: Port MCP Server from FastMCP to Official MCP SDK

## Problem Statement

Current MCP server implementation uses FastMCP which expects proprietary `~standard.vendor` metadata in client requests that standard MCP clients (like Claude Desktop) don't provide. This causes compatibility issues and prevents proper integration with standard MCP clients.

## Root Cause Analysis

**Error Category: Dependency Compatibility**
- FastMCP library expects non-standard metadata fields in incoming requests
- Standard MCP clients don't provide the expected `~standard.vendor` property
- This creates a compatibility barrier between our server and standard clients

## Requirements

1. **Replace FastMCP Dependency**: Remove `fastmcp` package and replace with `@modelcontextprotocol/sdk`

2. **Rewrite MCP Server**: Update `src/mcp/server.ts` to use official MCP SDK APIs:
   - Use `Server` class from official SDK
   - Implement proper request handlers (ListToolsRequestSchema, CallToolRequestSchema, etc.)
   - Use StdioServerTransport for transport layer

3. **Update Command Mapper**: Modify `src/mcp/command-mapper.ts` to work with official SDK:
   - Replace FastMCP-specific tool registration
   - Implement proper schema conversion from Zod to JSON Schema
   - Use official SDK's tool management

4. **Simplify Transport Layer**: Update `src/commands/mcp/index.ts`:
   - Remove SSE/httpStream transport options (deprecated)
   - Focus on stdio transport for standard compatibility
   - Remove port-related configurations

5. **Update Package Dependencies**:
   - Remove: `fastmcp`
   - Add: `@modelcontextprotocol/sdk`

## Acceptance Criteria

- [ ] FastMCP dependency completely removed from package.json
- [ ] Official MCP SDK dependency added and properly integrated
- [ ] Server successfully initializes with stdio transport
- [ ] Server properly responds to MCP initialize requests
- [ ] Tool registration works with new SDK approach
- [ ] All existing CLI commands continue to work through MCP bridge
- [ ] Compatible with Claude Desktop and other standard MCP clients
- [ ] No more `~standard.vendor` related errors

## Technical Notes

### Files to Modify
- `package.json` - Update dependencies
- `src/mcp/server.ts` - Complete rewrite using official SDK
- `src/mcp/command-mapper.ts` - Update for official SDK compatibility
- `src/commands/mcp/index.ts` - Simplify to stdio-only transport

### Migration Strategy
1. Install official MCP SDK
2. Rewrite server implementation
3. Update command mapper
4. Simplify transport configuration
5. Remove FastMCP dependency
6. Test with Claude Desktop integration

## Priority

**High** - Blocks proper MCP client integration and user adoption.
