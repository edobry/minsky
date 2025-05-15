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

   - Implement a hybrid approach with a central MCP server and path transformation layer
   - Add session context tracking for proper routing of operations
   - Create a secure path resolution system that enforces session boundaries
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

1. [ ] Path Resolution System:

   - [ ] Create a `SessionPathResolver` class to handle secure path operations:
     - [ ] Path normalization and validation
     - [ ] Containment verification (preventing path traversal outside session)
     - [ ] Relative to absolute path conversion within session context
   - [ ] Implement error types for different path violations
   - [ ] Add utility functions for common path operations

2. [ ] Session Context Management:

   - [ ] Design a `SessionContextManager` to track session information:
     - [ ] Store session paths and metadata
     - [ ] Associate agent IDs with active sessions
     - [ ] Provide context retrieval methods
   - [ ] Implement session context persistence
   - [ ] Add APIs for setting and retrieving current session context

3. [ ] Tool Wrapper Implementation:

   - [ ] Create wrapped versions of all file operation tools:
     - [ ] File reading/writing tools
     - [ ] Directory listing tools
     - [ ] File search tools
     - [ ] File editing tools
   - [ ] Ensure wrappers validate paths before operations
   - [ ] Add clear error reporting for boundary violations
   - [ ] Maintain API compatibility with original tools

4. [ ] MCP Server Integration:

   - [ ] Extend the MCP server to use session context:
     - [ ] Initialize with session path information
     - [ ] Configure tools with session context
     - [ ] Add session context to tool execution pipeline
   - [ ] Implement session ID parameter for relevant tools
   - [ ] Create a session discovery mechanism for AI agents

5. [ ] Session Start Enhancement:

   - [ ] Add MCP options to the `session start` command:
     - [ ] `--mcp` flag to enable MCP server
     - [ ] Transport configuration options
     - [ ] Port and host settings
   - [ ] Implement MCP server lifecycle management
   - [ ] Add session-specific configuration options

6. [ ] Security Enhancements:

   - [ ] Add comprehensive path traversal protection
   - [ ] Implement allowlist/blocklist for operations
   - [ ] Create audit logging for all file operations
   - [ ] Add mechanisms to prevent context leakage

7. [ ] Testing and Validation:

   - [ ] Create unit tests for path resolution
   - [ ] Implement integration tests for tool wrappers
   - [ ] Add end-to-end tests with simulated AI interactions
   - [ ] Create security-focused tests for boundary enforcement
   - [ ] Develop performance benchmarks for overhead measurement

8. [ ] Documentation and Examples:
   - [ ] Create detailed architecture documentation
   - [ ] Add examples of AI interactions with session-scoped MCP
   - [ ] Update existing documentation to reflect new capabilities
   - [ ] Create user guides for different use cases

## Verification

- [ ] `session start --mcp` successfully launches an MCP server for the session
- [ ] All file operations through MCP are correctly scoped to the session workspace
- [ ] Relative paths in tool calls are properly resolved within the session context
- [ ] Attempted operations outside the session workspace are blocked with clear error messages
- [ ] Performance overhead is minimal (less than 5% increase in operation time)
- [ ] AI agents can seamlessly interact with session-scoped MCP without special handling
- [ ] No file operations can accidentally leak out to modify the main workspace
- [ ] Documentation clearly explains the architecture and usage

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
