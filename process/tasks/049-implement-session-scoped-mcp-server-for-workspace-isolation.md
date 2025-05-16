# Task #049: Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

## Design Analysis

### Current System Behavior

The core issue stems from how AI coding agents interact with the filesystem:

1. Tools like `edit_file` resolve paths relative to the main workspace root
2. Even when an AI agent believes it's operating in a session directory, its file operations may target the main workspace
3. This creates an inherent conflict with Minsky's strict session isolation requirements
4. The current approach relies solely on rule-based enforcement, which is prone to human error and isn't technically enforced

### Approaches Considered

Four primary approaches were evaluated:

1. **Path Transformation Layer**: Add middleware to intercept file operations, transform paths, and enforce boundaries
   - **Pros**: Simple implementation, minimal architectural changes, transparent to AI agents
   - **Cons**: Processing overhead, potential for bypass if new tools are added without wrappers

2. **Session-Specific MCP Instances**: Launch dedicated MCP server instances for each session
   - **Pros**: Strong isolation, clear security boundaries, natural session lifecycle management
   - **Cons**: Resource overhead with multiple servers, port management complexity, requires agents to connect to specific endpoints

3. **Virtual Filesystem with Path Mapping**: Create a virtualized filesystem layer for all operations
   - **Pros**: Most robust approach, handles complex scenarios, clean abstractions
   - **Cons**: Most complex implementation, significant changes required, higher maintenance burden

4. **Centralized Router with Session Context**: One MCP server that routes based on session context
   - **Pros**: Resource efficient, centralized control, works across sessions
   - **Cons**: Requires changes to tool calls, risk of context leakage, complex context management

### Recommended Approach

A hybrid approach combining elements of options 1 and 4 is recommended:

1. Use a single MCP server (or small pool) for efficiency
2. Implement a robust path transformation layer for security
3. Add session context tracking for proper routing
4. Develop strict path validation to enforce boundaries

This provides the best balance of:
- Resource efficiency (no server per session)
- Strong isolation guarantees (strict path validation)
- Compatibility with existing workflows (minimal changes to agent behavior)
- Implementation simplicity (focused components with clear responsibilities)

## Advanced Use Cases Support

This approach supports several advanced usage scenarios:

1. **Multiple Cursor instances on different repos**: All use the same centralized MCP with different session contexts
2. **Single Cursor with multiple tabs on multiple repos**: Session context identifies which workspace to target
3. **Different agents isolated on same repo**: Use different session contexts to maintain isolation
4. **Multiple agents collaborating in same session**: Share the same session context identifier
5. **Remote/K8s deployments**: Centralized MCP with network transport and session context routing

## Requirements

1. **Centralized Session-Context MCP**

   - Implement a centralized MCP server that handles multiple sessions
   - Add session context parameters to all file operation tools
   - Ensure all operations are properly routed to the correct session workspace
   - Establish a clean API for context-aware tool execution

2. **Path Resolution Safety**

   - Implement a robust path resolution system that prevents any file operations outside the session directory
   - Handle relative paths by resolving them within the session workspace context
   - Block operations targeting the main workspace or other session workspaces
   - Provide clear error messages for path violations

3. **Session Context Management**

   - Design a system to track active sessions and their workspace paths
   - Support explicit session ID parameters for all relevant tool calls
   - Store and retrieve session paths securely from the session database
   - Provide an API for tools to resolve session context to workspace paths

4. **Cursor API Compatibility**

   - Ensure the MCP server exposes compatible tools for Cursor AI coding agents
   - Create session-aware wrappers for all file-modifying tools
   - Maintain compatibility with existing client expectations
   - Add session parameter to tool schemas with sensible defaults

5. **Session Registration**
   - Enhance the `session start` command to register sessions with the MCP context system
   - Provide session identification and discovery mechanisms
   - Support connecting AI agents to the appropriate session context
   - Update necessary documentation to reflect session context requirements

## Implementation Steps

1. [ ] Session Context Management:

   - [ ] Create a `SessionContextManager` to manage session information:
     - [ ] Lookup and retrieval of session workspace paths
     - [ ] Session validation and authorization
     - [ ] Integration with existing session database
   - [ ] Implement permanent storage of session path information
   - [ ] Add APIs for tools to access and use session context

2. [ ] Path Resolution System:

   - [ ] Create a `SessionPathResolver` class for secure path operations:
     - [ ] Session-specific path normalization and validation
     - [ ] Containment verification to prevent path traversal
     - [ ] Session-aware relative to absolute path conversion
   - [ ] Implement specialized error types for boundary violations
   - [ ] Add utility functions for common path operations

3. [ ] Session-Aware Tool Framework:

   - [ ] Design a tool wrapper system that enforces session context:
     - [ ] Tool parameter schemas with session context parameters
     - [ ] Pre-execution path validation and transformation
     - [ ] Post-execution path handling and result sanitization
   - [ ] Create a registration system for session-aware tools
   - [ ] Implement session context propagation between tool calls

4. [ ] File Operation Tool Implementations:

   - [ ] Create session-aware versions of essential file operation tools:
     - [ ] File reading/writing tools with context validation
     - [ ] Directory listing tools with path transformation
     - [ ] File search and code search with session scope
     - [ ] File editing tools with boundary enforcement
   - [ ] Ensure tools validate paths before operations
   - [ ] Add clear error reporting for boundary violations
   - [ ] Maintain API compatibility with existing tools

5. [ ] MCP Server Integration:

   - [ ] Enhance the central MCP server with session context capabilities:
     - [ ] Initialize with `SessionContextManager`
     - [ ] Register session-aware tool implementations
     - [ ] Add session context to all tool execution flows
   - [ ] Implement session context extraction from client requests
   - [ ] Create default session context resolution for backwards compatibility

6. [ ] Session Registration System:

   - [ ] Enhance the `session start` command:
     - [ ] Add session registration with the MCP context system
     - [ ] Provide connection information to the MCP server
     - [ ] Update client configuration for session awareness
   - [ ] Create mechanisms for session context discovery
   - [ ] Implement session workspace path lookup and verification

7. [ ] Testing and Validation:

   - [ ] Create unit tests for session context management
   - [ ] Implement integration tests for path resolution
   - [ ] Add end-to-end tests for session-aware tools
   - [ ] Create security-focused tests for boundary enforcement
   - [ ] Develop performance benchmarks for overhead measurement

8. [ ] Documentation and Examples:
   - [ ] Create detailed architecture documentation
   - [ ] Add examples of session-context aware MCP usage
   - [ ] Update existing documentation to reflect new capabilities
   - [ ] Create guides for different deployment scenarios

## Verification

- [ ] Session registration with MCP works when starting sessions
- [ ] Tools correctly route operations to the appropriate session workspace
- [ ] Relative paths in tool calls are properly resolved within the session context
- [ ] Operations targeting non-session directories are blocked with clear error messages
- [ ] Performance overhead is minimal (less than 5% increase in operation time)
- [ ] AI agents can seamlessly use session-scoped tools
- [ ] Session workspaces remain isolated with no cross-session interference
- [ ] Documentation clearly explains the centralized architecture and usage

## Technical Considerations

- **Security**: Ensure strict isolation between sessions and the main workspace
- **Performance**: Minimize overhead of path resolution and context tracking
- **Compatibility**: Maintain backward compatibility with existing AI workflows
- **Scalability**: Support multiple concurrent sessions with efficient resource usage
- **Error Handling**: Provide clear, actionable error messages for boundary violations
- **Configuration**: Support flexible configuration for different use cases
- **Testing**: Implement robust testing for security boundaries

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #047 (Configure MCP Server in Minsky Init Command)
- Related to task #039 (Prevent Session Creation Within Existing Sessions)

## Work Log

- 2024-07-14: Performed initial analysis of the problem and existing codebase
- 2024-07-14: Evaluated architectural approaches and selected hybrid approach
- 2024-07-14: Updated task specification with detailed design and implementation plan
- 2024-07-14: Revised specification to clarify centralized MCP approach with session context
