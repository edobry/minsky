# Task #034: Add MCP Support to Minsky

## Context

Minsky currently does not support the MCP (Machine Context Protocol) interface, which is required for enabling AI agents to interact with Minsky commands in a structured, programmatic way. Adding MCP support will allow external AI agents to query, invoke, and receive structured responses from Minsky commands, enabling advanced automation, integration, and agent-driven workflows.

## Requirements

1. **MCP Protocol Support**
   - Implement an MCP server or endpoint within Minsky that exposes its CLI commands via MCP.
   - Support structured request/response for all major Minsky commands (tasks, session, git, rules, etc.).
   - Ensure the protocol implementation is robust, secure, and extensible.

2. **Command Mapping**
   - Map all existing CLI commands to MCP actions, including argument and option parsing.
   - Ensure output is structured (e.g., JSON or MCP-native format) and includes error details.
   - Support both synchronous and asynchronous command execution where appropriate.

3. **AI Agent Integration**
   - Provide clear documentation and examples for how an AI agent can connect to and interact with Minsky via MCP.
   - Ensure authentication and access control are considered if exposing MCP over a network.

4. **Testing and Validation**
   - Add comprehensive tests for MCP endpoints, including edge cases and error handling.
   - Validate that all mapped commands behave identically via MCP and CLI.

5. **Documentation**
   - Update Minsky documentation to describe MCP support, usage, and integration patterns for AI agents.

## Implementation Plan

### Phase 1: Setup MCP Core Infrastructure

1. **Research and Library Setup**
   - Add FastMCP dependency to the project (`fastmcp` package)
   - Study the FastMCP API and MCP protocol specification
   - Identify the appropriate transport mechanism (stdio, SSE) for Minsky's use case

2. **Create Core MCP Module Structure**
   - Create a new `src/mcp` directory to house all MCP-related code
   - Implement a core `MinksyMCPServer` class using FastMCP that handles the protocol communication
   - Setup a configuration system for MCP server options (port, host, authentication, etc.)

3. **Command Structure Integration**
   - Create a tool registration system for mapping Minsky's commander.js-based commands to FastMCP tools
   - Implement necessary adapters for command output formatting
   - Set up error handling and standardized response formatting

### Phase 2: Command Mapping Implementation

1. **Map Task Commands**
   - Create MCP tools for task listing, creation, status management using FastMCP's `addTool` API
   - Implement Zod validation schemas for command parameters
   - Format responses as structured JSON data for AI consumption

2. **Map Session Commands**
   - Create MCP tools for session management (list, get, create, delete)
   - Support session directory retrieval and workspace information
   - Implement support for task-based session creation via MCP

3. **Map Git Commands**
   - Create MCP tools for git operations (commit, push, PR)
   - Handle asynchronous long-running operations through FastMCP's streaming capabilities
   - Implement proper error handling for git operations

4. **Map Init and Rules Commands**
   - Create MCP tools for project initialization and rules management
   - Support file system operations needed for these commands
   - Ensure secure access to file system resources

### Phase 3: Security and Testing

1. **Implement Authentication and Authorization**
   - Leverage FastMCP's built-in authentication system
   - Implement user context-aware MCP server to isolate user data
   - Add permission checks to prevent unauthorized access

2. **Write Comprehensive Tests**
   - Create unit tests for each MCP tool and server component
   - Use FastMCP's test utilities to simplify test creation
   - Test error handling and edge cases

3. **Create Documentation**
   - Document the Minsky MCP server API and available tools
   - Provide examples of connecting to and using Minsky via MCP
   - Update project README with MCP information

### Phase 4: Enhance MCP Interface

1. **Add Resource Endpoints**
   - Implement resource endpoints using FastMCP's resource API for data like tasks, sessions, and repositories
   - Create a structured data model for resource responses
   - Support filtering and pagination for resource queries

2. **Implement Streaming for Long-Running Commands**
   - Leverage FastMCP's built-in streaming capabilities for operations like git clone
   - Implement progress reporting for long-running operations
   - Ensure clients can handle partial and streaming responses

3. **Add MCP CLI Command**
   - Create a new `minsky mcp start` command to launch the MCP server
   - Support configuration options via CLI flags
   - Implement daemonization for background running (if needed)

## Detailed Implementation Steps

1. [x] Research and select an MCP protocol implementation or library suitable for Bun/TypeScript.
2. [x] Choose FastMCP as the implementation library due to its simplicity and feature completeness.
3. [ ] Add FastMCP dependency to package.json and install it
4. [ ] Create core MCP server module in src/mcp/server.ts using FastMCP
5. [ ] Create command mapping system in src/mcp/command-mapper.ts
6. [ ] Implement task command tools in src/mcp/tools/tasks.ts with Zod schemas
7. [ ] Implement session command tools in src/mcp/tools/session.ts with Zod schemas
8. [ ] Implement git command tools in src/mcp/tools/git.ts with Zod schemas
9. [ ] Implement init and rules tools in src/mcp/tools/init.ts with Zod schemas
10. [ ] Create MCP CLI command in src/commands/mcp/index.ts
11. [ ] Implement authentication using FastMCP's built-in system
12. [ ] Write comprehensive tests for MCP functionality
13. [ ] Create documentation and examples
14. [ ] Update README.md and CHANGELOG.md

## Technical Design Decisions

1. **MCP Library Selection**
   - Use FastMCP (`fastmcp` package) as the primary implementation library
   - Benefit from its declarative API, built-in authentication, and multiple transport options
   - Leverage Zod integration for type-safe parameter validation

2. **Transport Mechanism**
   - For local usage: Use stdio transport for direct process communication (FastMCP's default)
   - For remote usage: Implement SSE (Server-Sent Events) transport using FastMCP's built-in support
   - FastMCP handles the protocol negotiation automatically

3. **Command Mapping Approach**
   - Create a mapping system between Commander.js commands and FastMCP tools
   - Use Zod schemas to validate input parameters
   - Maintain parallel structure between CLI commands and MCP tools

4. **Authentication Strategy**
   - Use FastMCP's built-in authentication system
   - For local usage: Use process-level security (similar to current CLI)
   - For remote usage: Implement OAuth 2.1 via FastMCP's authentication hooks
   - Store tokens securely using existing session management

5. **Response Formatting**
   - Use FastMCP's standardized response format
   - Ensure consistent JSON structure for all command outputs
   - Leverage FastMCP's error handling for consistent error responses

## Verification

- [ ] All major Minsky commands are accessible via MCP
- [ ] AI agents can connect and interact with Minsky using MCP
- [ ] Structured responses and error handling are consistent with CLI behavior
- [ ] All tests pass for MCP endpoints
- [ ] Documentation is updated and includes integration examples

## Work Log

1. 2025-05-09: Researched MCP protocol and implementation options, analyzed Minsky codebase structure
2. 2025-05-09: Created detailed implementation plan
3. 2025-05-09: Researched FastMCP library and determined it's an ideal fit for Minsky's MCP implementation
