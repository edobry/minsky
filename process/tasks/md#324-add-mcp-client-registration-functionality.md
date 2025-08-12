# Task #324: Add MCP Client Registration Functionality

## Context

Currently, MCP server registration with clients like Cursor is only handled through the `minsky init` command, which creates `.cursor/mcp.json` configuration files. However, users may want to register the MCP server with clients without going through the full initialization process, and the registration logic is embedded in the init domain rather than being part of the MCP domain where it logically belongs.

Additionally, different MCP transports (stdio vs HTTP) warrant different approaches to registration:

- **stdio transport**: The MCP client is responsible for launching the server, so a registration command makes sense
- **HTTP transport**: The server must be launched independently and then registered, so a flag on `mcp start` might be more appropriate

This task involves investigating the best patterns for MCP client registration and implementing proper functionality in the MCP domain.

## Requirements

### 1. Investigation Phase

- **Analyze current registration patterns**: Examine how the `init` command currently handles MCP registration for different clients (Cursor, Claude Desktop, etc.)
- **Research MCP client conventions**: Investigate how different MCP clients (Cursor, Claude Desktop, VS Code with MCP extensions, etc.) expect server registration to work
- **Transport-specific patterns**: Understand the differences between stdio and HTTP transport registration requirements
- **Cross-platform considerations**: Ensure registration works across different operating systems and client configurations

### 2. Domain Architecture Refactoring

- **Extract registration logic**: Move MCP configuration generation logic from `src/domain/init.ts` to a dedicated MCP domain module
- **Create registration service**: Design a clean interface for registering with different types of MCP clients
- **Support multiple clients**: Enable registration with multiple clients simultaneously (Cursor, Claude Desktop, VS Code, etc.)
- **Configuration templates**: Create reusable templates for different client types and transport configurations

### 3. Command Interface Design

#### Option A: Dedicated Registration Command

```bash
# Register with Cursor using stdio transport (default)
minsky mcp register --client cursor

# Register with Claude Desktop using HTTP transport
minsky mcp register --client claude --transport http --port 3000

# Register with multiple clients
minsky mcp register --client cursor,claude --transport stdio
```

#### Option B: Integration with Start Command

```bash
# Start server and register with Cursor
minsky mcp start --register cursor

# Start HTTP server and register with Claude
minsky mcp start --http --register claude --port 3000
```

#### Option C: Hybrid Approach

```bash
# Dedicated registration for stdio (client-managed servers)
minsky mcp register --client cursor

# Integrated registration for HTTP (independent servers)
minsky mcp start --http --register claude --port 3000
```

### 4. Transport-Specific Implementation

#### stdio Transport Registration

- Generate client configuration files (`.cursor/mcp.json`, Claude config, etc.)
- Configure client to launch `minsky mcp start` with appropriate arguments
- Handle client-specific configuration format differences
- Support workspace-specific vs global registration

#### HTTP Transport Registration

- Start HTTP server first
- Register running server with client configuration
- Handle server lifecycle management
- Support server discovery and health checking

### 5. Client Support Matrix

| Client         | stdio Support  | HTTP Support   | Config Location    | Config Format |
| -------------- | -------------- | -------------- | ------------------ | ------------- |
| Cursor         | ✅ Primary     | ✅ Secondary   | `.cursor/mcp.json` | JSON          |
| Claude Desktop | ✅ Primary     | ❓ Investigate | OS-specific        | JSON          |
| VS Code MCP    | ❓ Investigate | ❓ Investigate | `.vscode/`         | ❓            |
| Custom Clients | ✅ Generic     | ✅ Generic     | Configurable       | JSON          |

## Implementation Plan

### Phase 1: Analysis and Extraction

1. **Current state analysis**

   - Document existing registration logic in `src/domain/init.ts`
   - Identify all MCP configuration patterns currently supported
   - Map client-specific configuration requirements

2. **Domain refactoring**
   - Create `src/domain/mcp/registration.ts` module
   - Extract `getMCPConfigContent` and related functions from init domain
   - Design clean interfaces for registration operations

### Phase 2: Investigation and Design

1. **Client research**

   - Test registration patterns with Cursor, Claude Desktop
   - Document configuration file formats and locations
   - Identify transport-specific requirements

2. **Transport analysis**
   - Analyze stdio vs HTTP registration workflows
   - Determine optimal command interface patterns
   - Design unified registration service

### Phase 3: Command Implementation

1. **Core registration service**

   - Implement `MCPRegistrationService` class
   - Support multiple clients and transports
   - Handle configuration file generation and placement

2. **Command interface**
   - Implement chosen command pattern (dedicated vs integrated)
   - Add comprehensive CLI options and validation
   - Ensure backward compatibility with init command

### Phase 4: Testing and Documentation

1. **Testing strategy**

   - Unit tests for registration service
   - Integration tests with actual MCP clients
   - Cross-platform compatibility testing

2. **Documentation updates**
   - Update README-MCP.md with registration commands
   - Add examples for different clients and transports
   - Document troubleshooting for registration issues

## Technical Considerations

### Configuration Management

- **File location discovery**: Automatically detect appropriate config locations for different clients
- **Merge strategies**: Handle existing configuration files without overwriting other servers
- **Validation**: Ensure generated configurations are valid for target clients

### Error Handling

- **Permission issues**: Handle cases where config directories are not writable
- **Client detection**: Gracefully handle cases where target clients are not installed
- **Network conflicts**: Detect and resolve port conflicts for HTTP transport

### Security

- **Localhost binding**: Ensure HTTP servers only bind to localhost by default
- **Configuration isolation**: Prevent one client's configuration from affecting others
- **Credential management**: Handle any authentication requirements properly

## Success Criteria

- [ ] MCP registration logic is cleanly separated from init domain
- [ ] Users can register with Cursor without running `minsky init`
- [ ] Both stdio and HTTP transports support registration workflows
- [ ] Registration works with multiple MCP clients simultaneously
- [ ] Command interface is intuitive and follows Minsky CLI conventions
- [ ] All existing init command MCP functionality continues to work
- [ ] Comprehensive tests cover registration scenarios
- [ ] Documentation clearly explains registration options and workflows

## Questions for Investigation

1. **Command Design**: Should we use a dedicated `mcp register` command, integrate with `mcp start`, or provide both options?

2. **HTTP Transport Registration**: For HTTP transport, should registration be:

   - A flag on `mcp start` (registers while starting server)?
   - A separate command that registers a running server?
   - Both options available?

3. **Client Detection**: Should the system auto-detect installed MCP clients or require explicit client specification?

4. **Configuration Merging**: How should we handle existing MCP configurations that already have other servers registered?

5. **Global vs Local**: Should registration support both workspace-specific and global (user-level) client configurations?

6. **Transport Defaults**: What should be the default transport when registering with different clients?

## Dependencies

- Existing MCP domain (`src/mcp/server.ts`, `src/mcp/command-mapper.ts`)
- Current init command MCP logic (`src/domain/init.ts`)
- MCP client research and testing
- Cross-platform configuration file handling

## Related Tasks

- Task #047: Configure MCP Server in Minsky Init Command (completed)
- Task #282: Port MCP Server from FastMCP to Official MCP SDK (completed)
- Task #286: Fix MCP Server and CLI Issues Post Task 282 (completed)

This task represents a natural evolution of the MCP functionality, moving from initialization-only registration to a full-featured registration system that supports the growing ecosystem of MCP clients and use cases.
