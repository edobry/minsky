# Fix MCP Server and CLI Issues Post Task 282

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Fix MCP Server and CLI Issues Post Task 282

## Context

After merging task 282 changes that ported the MCP server from FastMCP to the official MCP SDK, several issues have emerged with the MCP server and CLI functionality:

1. **Missing HTTP Transport**: The streaming HTTP transport option was removed during the migration to the official SDK, but users still need network-accessible MCP servers
2. **Inspector Browser Launch Issues**: The inspector doesn't automatically open in the browser when started, and lacks proper preconfiguration with auth and MCP connection options
3. **Outdated Inspector Version**: The MCP inspector is using version 0.14.3 which appears to be outdated and needs upgrading to the latest version

These issues are blocking proper MCP server usage and development workflows that depend on network transports and inspector debugging capabilities.

## Requirements

### 1. Restore Streaming HTTP Transport Option

- **Restore HTTP transport support** that was removed in task 282
- Implement HTTP transport using the official MCP SDK patterns
- Support both stdio (default) and HTTP streaming transports
- Maintain backward compatibility with existing CLI commands
- Update transport configuration in `src/commands/mcp/index.ts`
- Ensure proper server startup with HTTP transport option

### 2. Fix Inspector Integration Issues

- **Fix automatic browser opening** when inspector is launched
- **Preconfigure inspector with authentication** and MCP connection settings
- **Resolve connection setup** between inspector and MCP server
- Update `src/mcp/inspector-launcher.ts` to handle proper browser launching
- Fix environment variable configuration for inspector auto-open
- Ensure inspector can properly connect to both stdio and HTTP transports

### 3. Upgrade MCP Inspector to Latest Version

- **Research and identify the latest MCP inspector version** available
- **Update package.json** to use the latest `@modelcontextprotocol/inspector` version
- **Test compatibility** with the official MCP SDK implementation
- **Update integration code** if APIs have changed between versions
- **Verify inspector functionality** with both transport types

### 4. Update Documentation and CLI Help

- **Update README-MCP.md** to reflect restored HTTP transport options
- **Document inspector usage** with new version and configuration
- **Update CLI help text** for MCP commands to show available transport options
- **Add examples** for using HTTP transport with inspector
- **Document troubleshooting steps** for common inspector issues

## Implementation Steps

### Phase 1: Research and Planning

- [ ] Research latest MCP inspector version and changelog
- [ ] Analyze what transport options are available in official MCP SDK
- [ ] Review how other MCP implementations handle HTTP transport
- [ ] Document current issues and expected behavior

### Phase 2: Restore HTTP Transport

- [ ] Add HTTP transport support back to `src/mcp/server.ts`
- [ ] Update `src/commands/mcp/index.ts` to support HTTP transport options
- [ ] Add necessary CLI flags for HTTP transport configuration
- [ ] Test HTTP transport functionality with official MCP SDK
- [ ] Ensure proper error handling for transport failures

### Phase 3: Fix Inspector Integration

- [ ] Update `src/mcp/inspector-launcher.ts` for proper browser launching
- [ ] Fix environment variable configuration for auto-open
- [ ] Resolve connection setup between inspector and MCP server
- [ ] Test inspector with both stdio and HTTP transports
- [ ] Fix authentication and connection preconfiguration

### Phase 4: Upgrade Inspector Version

- [ ] Update `@modelcontextprotocol/inspector` to latest version in package.json
- [ ] Test compatibility with updated inspector
- [ ] Update integration code for any API changes
- [ ] Verify all inspector functionality works with new version
- [ ] Update inspector availability checking logic if needed

### Phase 5: Update Documentation

- [ ] Update README-MCP.md with restored HTTP transport documentation
- [ ] Add inspector troubleshooting section
- [ ] Update CLI help text and examples
- [ ] Document new inspector version features
- [ ] Add usage examples for HTTP transport with inspector

## Verification Criteria

### HTTP Transport Verification
- [ ] `minsky mcp start --http-stream --port 3000` successfully starts HTTP server
- [ ] HTTP transport properly exposes MCP tools and can handle requests
- [ ] CLI shows appropriate help text for HTTP transport options
- [ ] Server can handle both stdio and HTTP transport modes

### Inspector Integration Verification
- [ ] `minsky mcp start --with-inspector` automatically opens browser
- [ ] Inspector successfully connects to MCP server
- [ ] Inspector shows all available tools and can execute them
- [ ] Inspector works with both stdio and HTTP transport modes
- [ ] Authentication and connection setup works properly

### Inspector Version Verification
- [ ] Latest MCP inspector version is installed and working
- [ ] No compatibility issues with official MCP SDK
- [ ] All inspector features function correctly
- [ ] Inspector startup is reliable and consistent

### Documentation Verification
- [ ] README-MCP.md accurately reflects all transport options
- [ ] CLI help text shows correct usage information
- [ ] Troubleshooting documentation helps resolve common issues
- [ ] Examples work as documented

## Success Criteria

This task is complete when:

1. **HTTP transport is fully functional** - Users can start MCP servers with HTTP transport and connect external clients
2. **Inspector launches and connects properly** - The `--with-inspector` flag opens browser and establishes working connection
3. **Latest inspector version is working** - Updated inspector provides improved functionality and reliability
4. **Documentation is accurate and helpful** - Users can successfully use MCP server in all supported configurations

## Priority

**High** - These issues are blocking proper MCP server usage and development workflows that are essential for AI agent integration and debugging capabilities.


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
