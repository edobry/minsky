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

1. [ ] Research and Architecture Design:

   - [ ] Document current MCP implementation and capabilities
   - [ ] Research path resolution and sandbox techniques for filesystem operations
   - [ ] Design and document the optimal architecture for session-scoped MCP
   - [ ] Create technical specification for implementation

2. [ ] Core Isolation Implementation:

   - [ ] Create path resolution and validation utilities for session workspaces
   - [ ] Implement session context tracking system
   - [ ] Develop wrapper mechanisms for standard file operation tools
   - [ ] Add security controls to prevent workspace boundary violations

3. [ ] MCP Server Integration:

   - [ ] Extend `session start` command to configure MCP for the session
   - [ ] Implement MCP server initialization with session context
   - [ ] Create session-aware tool set with proper isolation
   - [ ] Add session routing capabilities to MCP server

4. [ ] CLI and User Experience:

   - [ ] Add command-line options for MCP configuration in `session start`
   - [ ] Create commands to manage MCP server lifecycle
   - [ ] Implement status reporting for session MCP servers
   - [ ] Add documentation for MCP-enabled sessions

5. [ ] Testing and Validation:

   - [ ] Create comprehensive test suite for path resolution security
   - [ ] Implement integration tests for session-scoped MCP
   - [ ] Test with various AI agent interactions to verify isolation
   - [ ] Validate performance and resource usage

6. [ ] Documentation and Examples:
   - [ ] Document architecture and security model
   - [ ] Create examples for AI interactions with session-scoped MCP
   - [ ] Update existing documentation to highlight the new capabilities
   - [ ] Add migration guides for transitioning from rule-based enforcement

## Verification

- [ ] `session start` command successfully configures and optionally launches an MCP server for the session
- [ ] All file operations through MCP are correctly scoped to the session workspace
- [ ] Relative paths in tool calls are properly resolved within the session context
- [ ] Attempted operations outside the session workspace are blocked or redirected
- [ ] Performance is acceptable with no significant resource overhead
- [ ] AI agents can seamlessly interact with the session-scoped MCP without special handling
- [ ] No file operations can accidentally leak out to modify the main workspace
- [ ] Documentation clearly explains the architecture and usage

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
