# Task #049: Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

<<<<<<< HEAD
## Updated Analysis

After comprehensive analysis of the current architecture and future direction:

1. **Root Cause**: AI tools resolve relative paths against the main workspace, not the session workspace
2. **Architecture Alignment**: Solution must align with domain-driven design and interface-agnostic patterns
3. **Future Compatibility**: Must support planned non-filesystem workspaces and database backends
4. **Pattern Consistency**: Should follow "preventing bypass patterns" architectural principles

## Requirements

1. **MCP File Operation Tools**

   - Create a comprehensive set of file operation tools in the MCP server
   - Tools should mirror common AI agent operations: `file.read`, `file.write`, `file.edit`, `file.delete`, `file.list`
   - All tools must enforce session workspace boundaries automatically
   - Provide transparent path resolution that works with both relative and absolute paths

2. **Path Resolution Safety**

   - Implement a robust `SessionPathResolver` class that:
     - Converts all paths to absolute paths within the session workspace
     - Validates paths don't escape session boundaries (no `../` traversal attacks)
     - Handles edge cases like symlinks and mount points
   - Provide clear, actionable error messages for path violations
   - Log all path resolutions for debugging and audit purposes

3. **Session Context Integration**

   - Extend the existing `ProjectContext` to include session information
   - Pass session context through MCP server initialization via `--session` parameter
   - Use session context for all file operation path resolutions
   - Support both session-scoped and main workspace MCP servers
=======
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

### Refined Approach: Session-Specific Tools

After analyzing the immediate needs and long-term goals, we've refined our approach to focus on creating explicit session-scoped tools:

1. Create new MCP tools with names like `session_edit_file`, `session_read_file`, etc.
2. Each tool requires explicit session parameters for clear context
3. Implement strict path validation to ensure operations stay within session boundaries
4. Use a centralized MCP server for resource efficiency

This approach provides:
- Clear separation between standard and session-scoped tools
- Explicit session context through required parameters
- Strong path validation and boundary enforcement
- Incremental implementation with immediate benefits

## Advanced Use Cases Support

This approach supports several advanced usage scenarios:

1. **Multiple Cursor instances on different repos**: All use the same centralized MCP with explicit session parameters
2. **Single Cursor with multiple tabs on multiple repos**: Each tab specifies its session context when using tools
3. **Different agents isolated on same repo**: Each agent uses different session identifiers
4. **Multiple agents collaborating in same session**: Multiple agents use identical session parameters
5. **Remote/K8s deployments**: Central MCP server handles session routing based on explicit parameters

## Requirements

1. **Session-Specific MCP Tools**

   - Create new MCP tools with names prefixed with `session_` (e.g., `session_edit_file`)
   - Require explicit session identifier parameters for all session tools
   - Implement session workspace path resolution for each tool
   - Provide clear documentation on tool usage patterns

2. **Path Resolution Safety**

   - Implement path validation to prevent operations outside session boundaries
   - Transform relative paths to absolute paths within the correct session workspace
   - Block operations targeting the main workspace or other session workspaces
   - Provide clear error messages for boundary violations

3. **Session Lookup and Validation**

   - Create utilities to lookup session information by name or task ID
   - Validate session existence and status before operations
   - Retrieve session workspace paths from the session database
   - Handle graceful error cases for invalid sessions
>>>>>>> 4d93d2ababdce29badf5ebf6d50956901ff8c7a9

4. **Tool Registration and Discovery**

<<<<<<< HEAD
   - Ensure MCP tools are compatible with Cursor's expected file operation patterns
   - Provide tool descriptions that guide AI agents to use MCP tools over native tools
   - Consider tool naming that makes them discoverable and preferred by AI agents
   - Document how to configure Cursor to prioritize MCP tools

5. **Architecture Alignment**

   - Design file operations as an abstraction layer (similar to DatabaseStorage)
   - Prepare for future non-filesystem workspace implementations
   - Follow interface-agnostic command patterns
   - Implement proper error handling following project patterns

## Implementation Steps

1. [ ] Design File Operation Abstraction:

   - [ ] Create `FileOperationProvider` interface for future extensibility
   - [ ] Design `SessionFileOperations` implementation for current filesystem needs
   - [ ] Plan for future `RemoteFileOperations` or `DatabaseFileOperations`
   - [ ] Document the abstraction architecture

2. [ ] Implement Path Resolution System:

   - [ ] Create `SessionPathResolver` class with comprehensive path validation
   - [ ] Implement path normalization and boundary checking
   - [ ] Add symlink resolution and security checks
   - [ ] Create comprehensive test suite for path edge cases

3. [ ] Create MCP File Operation Tools:

   - [ ] Implement `file.read` tool with session path enforcement
   - [ ] Implement `file.write` tool with atomic write operations
   - [ ] Implement `file.edit` tool supporting incremental changes
   - [ ] Implement `file.delete` tool with safety checks
   - [ ] Implement `file.list` tool for directory operations
   - [ ] Add proper Zod schemas for all tool parameters

4. [ ] Enhance Session Context:

   - [ ] Extend `ProjectContext` interface to include `sessionInfo`
   - [ ] Modify MCP server initialization to accept `--session` parameter
   - [ ] Update `CommandMapper` to pass session context to file tools
   - [ ] Ensure context is available throughout tool execution

5. [ ] Integration and Testing:

   - [ ] Create adapter layer in `src/adapters/mcp/files.ts`
   - [ ] Register file tools in MCP server initialization
   - [ ] Add comprehensive integration tests
   - [ ] Test with actual AI agent interactions
   - [ ] Verify isolation with various path attack scenarios

6. [ ] Documentation and Migration:

   - [ ] Document MCP file operation tools and their usage
   - [ ] Create Cursor configuration guide for MCP tool prioritization
   - [ ] Update session workflow documentation
   - [ ] Create migration guide from rule-based to tool-based enforcement

## Verification

- [ ] File operations through MCP tools are strictly scoped to session workspace
- [ ] Relative paths are correctly resolved within session context
- [ ] Path traversal attempts are blocked with clear error messages
- [ ] AI agents can use MCP file tools transparently
- [ ] Performance overhead is minimal (< 10ms per operation)
- [ ] All edge cases are handled (symlinks, permissions, non-existent files)
- [ ] Integration works seamlessly with existing Minsky workflows
- [ ] Documentation clearly explains the security model and usage

## Technical Considerations

- **Security**: Implement defense-in-depth with multiple validation layers
- **Performance**: Cache path resolutions where safe to do so
- **Compatibility**: Ensure tools work with various AI agent implementations
- **Scalability**: Design for future multi-session scenarios
- **Error Handling**: Follow project's error handling patterns consistently
- **Logging**: Implement audit logging for compliance and debugging
- **Testing**: Create property-based tests for path resolution logic

## Architecture Decision Records

1. **ADR-001**: Chose MCP File Operation Proxy over per-session servers for resource efficiency
2. **ADR-002**: Implemented abstraction layer to support future non-filesystem workspaces
3. **ADR-003**: Used existing ProjectContext pattern for session information propagation
4. **ADR-004**: Aligned with domain-driven design by keeping file operations in adapter layer
=======
   - Register session tools with the central MCP server
   - Provide discovery mechanisms for available session tools
   - Implement consistent parameter patterns across all session tools
   - Document session tool schemas for AI agent consumption

5. **Session Documentation and Examples**
   - Create comprehensive documentation for session tool usage
   - Provide examples of session-aware AI workflows
   - Document migration from standard tools to session tools
   - Create guides for different session usage patterns

6. **Mandatory Session Tools Rule**
   - Create a Cursor rule mandating the use of session-specific tools when in a session
   - Make the rule explicitly require `session_` prefixed tools instead of built-ins
   - Add clear warnings about the risks of using built-in tools directly
   - Provide examples showing correct and incorrect tool usage patterns
   - Ensure the rule is automatically loaded in session contexts

## Implementation Steps

1. [ ] Core Session Utilities:

   - [ ] Create a `SessionPathResolver` module:
     - [ ] Session path retrieval and validation
     - [ ] Path containment verification
     - [ ] Path transformation utilities
   - [ ] Implement session-specific error types
   - [ ] Add session workspace lookup functions

2. [ ] Essential Session Tools (Phase 1):

   - [ ] Create `session_edit_file` tool:
     - [ ] Define schema with session parameter
     - [ ] Implement path validation and transformation
     - [ ] Provide clear error messages for boundary violations
   - [ ] Create `session_read_file` tool with similar structure
   - [ ] Implement `session_list_dir` for directory operations
   - [ ] Add registration for these tools to the MCP server

3. [ ] Additional Session Tools (Phase 2):

   - [ ] Implement `session_grep_search` for text searching
   - [ ] Create `session_codebase_search` for semantic code search
   - [ ] Add `session_file_search` for path-based file finding
   - [ ] Develop utility tools like `session_delete_file`
   - [ ] Ensure all tools follow consistent parameter patterns

4. [ ] Tool Documentation and Examples:

   - [ ] Create detailed documentation for each session tool
   - [ ] Add examples of session-aware AI agent prompts
   - [ ] Provide migration guides from standard tools
   - [ ] Document common error cases and solutions

5. [ ] Session Integration:

   - [ ] Add session tool documentation to the session start output
   - [ ] Create helper utilities for session tool discovery
   - [ ] Implement logging for session tool operations
   - [ ] Add session tool reference to project documentation

6. [ ] Cursor Rule Development:

   - [ ] Create a new `session-tools.mdc` rule file:
     - [ ] Add clear mandate for using session-specific tools
     - [ ] Include examples of correct and incorrect patterns
     - [ ] Explain the risks of bypassing session tools
     - [ ] Provide guidance for transitioning to session tools
   - [ ] Integrate rule with session workflows
   - [ ] Add automatic rule loading for session contexts

7. [ ] Testing and Validation:

   - [ ] Create unit tests for session path resolution
   - [ ] Implement integration tests for session tools
   - [ ] Add security tests for boundary enforcement
   - [ ] Create end-to-end tests with AI agent simulation
   - [ ] Validate rule effectiveness with AI agent interactions

## Verification

- [ ] Session-specific tools correctly restrict operations to the session workspace
- [ ] Relative paths in tool calls are properly resolved within the session context
- [ ] Operations targeting non-session directories are blocked with clear error messages
- [ ] AI agents can easily use session tools with explicit session parameters
- [ ] Session workspaces remain isolated with no cross-session interference
- [ ] Documentation clearly explains the session tool usage pattern
- [ ] Cursor rule effectively guides AI agents to use session-specific tools

## Technical Considerations

- **Security**: Ensure strict isolation between sessions and the main workspace
- **Usability**: Make session parameters clear and consistent across tools
- **Compatibility**: Maintain standard tools alongside session tools during transition
- **Error Messages**: Provide informative, actionable error messages
- **Documentation**: Create comprehensive guides for AI agent usage
- **Performance**: Minimize overhead of session path resolution
- **Rule Enforcement**: Balance strong guidance with practical flexibility
>>>>>>> 4d93d2ababdce29badf5ebf6d50956901ff8c7a9

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #047 (Configure MCP Server in Minsky Init Command)
- Related to task #039 (Prevent Session Creation Within Existing Sessions)
<<<<<<< HEAD
- Influenced by task #090 (Prepare for Future Non-Filesystem Workspaces)
- Aligned with task #091 (Enhance SessionDB with Multiple Backend Support)
=======

## Work Log

- 2024-07-14: Performed initial analysis of the problem and existing codebase
- 2024-07-14: Evaluated architectural approaches and selected hybrid approach
- 2024-07-14: Updated task specification with detailed design and implementation plan
- 2024-07-14: Revised specification to clarify centralized MCP approach with session context
- 2024-07-14: Refined approach to focus on explicit session-specific tools
- 2024-07-14: Added requirement for Cursor rule mandating use of session-specific tools
>>>>>>> 4d93d2ababdce29badf5ebf6d50956901ff8c7a9
