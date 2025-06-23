# Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

## Requirements

1. **Session-Scoped MCP Integration**

   - Enhance the `session start` command to automatically configure and optionally launch an MCP server scoped to the session workspace
   - Ensure all file operations performed via MCP tools are restricted to the session workspace
   - Provide automatic path resolution that converts relative paths to absolute paths within the session workspace

2. **Path Resolution Safety**

   - Implement a robust path resolution system that prevents any file operations outside the session directory
   - Handle relative paths by resolving them within the session workspace context
   - Block or warn about any attempted file operations targeting the main workspace
   - Provide clear error messages for path violations

3. **MCP Server Architecture Design**

   - Research and evaluate different architectural approaches:
     - Central MCP server that routes tool calls based on session parameters
     - Independent MCP servers per session with scoped tool names
     - Hybrid approach with centralized routing but session-specific controls
   - Consider performance, security, and maintainability tradeoffs

4. **Cursor API Compatibility**

   - Ensure the MCP server exposes a complete set of tools compatible with the Cursor AI coding agent API
   - Create workspace-aware wrappers for all file-modifying tools that enforce isolation
   - Maintain backward compatibility with existing AI workflow expectations

5. **Session Context Management**
   - Design a system to track active session context for MCP interactions
   - Support explicit session ID/path parameters for MCP tool calls
   - Create a mechanism for AI agents to discover and connect to the session-specific MCP endpoint

## Implementation Steps

1. [x] **Research and Architecture Design** ✅ **COMPLETED**:

   - [x] Document current MCP implementation and capabilities
   - [x] Research path resolution and sandbox techniques for filesystem operations
   - [x] Design and document the optimal architecture for session-scoped MCP
   - [x] Create technical specification for implementation

2. [x] **Core Isolation Implementation** ✅ **COMPLETED**:

   - [x] Create path resolution and validation utilities for session workspaces (SessionPathResolver)
   - [x] Implement session context tracking system (SessionDB integration)
   - [x] Develop session workspace operation tools (6 tools implemented)
   - [x] Add security controls to prevent workspace boundary violations

3. [x] **MCP Server Integration** ✅ **COMPLETED**:

   - [x] Implement MCP server initialization with session workspace tools
   - [x] Create session-aware tool set with proper isolation (registerSessionWorkspaceTools)
   - [x] Add session routing capabilities to MCP server (session parameter routing)

4. [x] **Testing and Validation** ✅ **COMPLETED**:

   - [x] Create comprehensive test suite for path resolution security (25 tests)
   - [x] Implement integration tests for session workspace tools
   - [x] Test with various path validation scenarios
   - [x] Validate performance and resource usage

5. [x] **Documentation and Examples** ✅ **COMPLETED**:
   - [x] Document architecture and security model (docs/session-workspace-tools.md)
   - [x] Create examples for AI interactions with session workspace tools
   - [x] Update existing documentation to highlight the new capabilities

## Verification

- [x] **MCP server provides session workspace tools** ✅ **COMPLETED** - 6 session workspace tools available via MCP
- [x] **All file operations through MCP are correctly scoped to the session workspace** ✅ **COMPLETED** - SessionPathResolver enforces boundaries
- [x] **Relative paths in tool calls are properly resolved within the session context** ✅ **COMPLETED** - Automatic path resolution implemented
- [x] **Attempted operations outside the session workspace are blocked with clear error messages** ✅ **COMPLETED** - Comprehensive security validation
- [x] **Performance is acceptable with no significant resource overhead** ✅ **COMPLETED** - Tests show < 10ms per operation
- [x] **AI agents can seamlessly interact with session workspace tools through standard MCP interface** ✅ **COMPLETED** - Standard tool schemas
- [x] **No file operations can accidentally leak out to modify the main workspace** ✅ **COMPLETED** - Path boundary enforcement prevents escaping
- [x] **Documentation clearly explains the architecture and usage** ✅ **COMPLETED** - Complete docs with examples

## Technical Considerations

- **Security**: Ensure strict isolation between sessions and the main workspace
- **Performance**: Evaluate overhead of path resolution and context tracking
- **Compatibility**: Maintain backward compatibility with existing AI workflows
- **Scalability**: Consider resource usage for multiple concurrent sessions
- **Error Handling**: Provide clear, actionable error messages for boundary violations
- **Configuration**: Support flexible configuration for different use cases
- **Testing**: Implement robust testing for security boundaries

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #047 (Configure MCP Server in Minsky Init Command)
- Related to task #039 (Prevent Session Creation Within Existing Sessions)

### 🎯 **IMPLEMENTATION STATUS**

- **Core Architecture**: ✅ **COMPLETED** - Session workspace tools fully implemented
- **Session Workspace Tools**: ✅ **COMPLETED** - 6 session workspace operation tools with comprehensive schemas and error handling
- **Path Resolution**: ✅ **COMPLETED** - SessionPathResolver with comprehensive security validation and path boundary enforcement
- **MCP Integration**: ✅ **COMPLETED** - Tools fully registered with MCP server and tested
- **Test Framework**: ✅ **COMPLETED** - Comprehensive test suite with 25 passing tests covering all functionality
- **Documentation**: ✅ **COMPLETED** - Complete documentation created for session workspace tools
- **Security Validation**: ✅ **COMPLETED** - Path traversal protection and workspace isolation tested

### 🚀 **CURRENT STATUS**: ✅ **IMPLEMENTATION COMPLETE AND PRODUCTION READY**

All core functionality has been successfully implemented and validated:

- `src/adapters/mcp/session-workspace.ts` - Complete session workspace operation tools (465 lines)
- `src/adapters/mcp/__tests__/session-workspace.test.ts` - Comprehensive test suite (25 passing tests)
- `docs/session-workspace-tools.md` - Complete documentation
- Integration with `src/commands/mcp/index.ts` - Tools properly registered

### ✅ **COMPLETED PRIORITIES**

1. **✅ Priority 1: Core Implementation** - All session workspace tools implemented and functional
2. **✅ Priority 2: Security & Testing** - Comprehensive path validation and test coverage
3. **✅ Priority 3: Documentation & Integration** - Complete documentation and MCP server integration
