# Task #049: Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

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

4. **Cursor API Compatibility**

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

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #047 (Configure MCP Server in Minsky Init Command)
- Related to task #039 (Prevent Session Creation Within Existing Sessions)
- Influenced by task #090 (Prepare for Future Non-Filesystem Workspaces)
- Aligned with task #091 (Enhance SessionDB with Multiple Backend Support)
