# Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

## Updated Analysis

After comprehensive analysis of the current architecture and future direction:

1. **Root Cause**: AI tools resolve relative paths against the main workspace, not the session workspace
2. **Architecture Alignment**: Solution must align with domain-driven design and interface-agnostic patterns
3. **Future Compatibility**: Must support planned non-filesystem workspaces and database backends
4. **Pattern Consistency**: Should follow "preventing bypass patterns" architectural principles

### Current System Behavior

The core issue stems from how AI coding agents interact with the filesystem:

1. Tools like `edit_file` resolve paths relative to the main workspace root
2. Even when an AI agent believes it's operating in a session directory, its file operations may target the main workspace
3. This creates an inherent conflict with Minsky's strict session isolation requirements
4. The current approach relies solely on rule-based enforcement, which is prone to human error and isn't technically enforced

### Selected Approach: Session-Aware Tools with Local Filesystem

For the **current local filesystem implementation**, we're implementing session-aware tools that:

- Require explicit session parameters for all operations
- Enforce session workspace boundaries through path validation
- Use centralized MCP server for resource efficiency
- Provide clear separation between standard and session-scoped tools

### Future Docker Considerations

**Note**: While this task focuses on local filesystem implementation, the architecture is designed to support future Docker containerization where session workspaces will run in containers. The session-aware tools approach will adapt well to container-based workspaces by routing operations to container APIs instead of local filesystem operations.

## Requirements

1. **Session-Scoped File Operation Tools**

   - Create comprehensive session-aware file operation tools in the MCP server
   - Tools must require explicit session parameters for all operations
   - Ensure all file operations are restricted to the specified session workspace
   - Provide automatic path resolution within the session workspace context

2. **Path Resolution Safety**

   - Implement robust path validation that prevents operations outside session boundaries
   - Handle relative paths by resolving them within the session workspace context
   - Block operations targeting the main workspace or other session workspaces
   - Provide clear, actionable error messages for path violations

3. **Single Persistent MCP Server Architecture**

   - Use one persistent MCP server that handles all session operations
   - Implement session routing based on explicit session parameters
   - Avoid per-session server instances for resource efficiency
   - Support multiple concurrent sessions through parameter-based routing

4. **Session Context Management**

   - Implement session lookup and validation utilities
   - Support session identification by name or task ID
   - Validate session existence and status before operations
   - Provide session workspace path resolution from session database

5. **Security and Isolation**
   - Enforce strict boundaries between session workspaces
   - Prevent accidental cross-session contamination
   - Block path traversal attempts and other security vulnerabilities
   - Maintain audit trail of all session file operations

## Implementation Steps

1. [x] **Design File Operation Abstraction**: ✅ **COMPLETE**

   - [x] Create `WorkspaceBackend` interface for future extensibility
   - [x] Design `LocalWorkspaceBackend` implementation for filesystem needs
   - [x] Plan abstraction for future non-filesystem workspaces
   - [x] Document the abstraction architecture

2. [x] **Implement Path Resolution System**: ✅ **COMPLETE**

   - [x] Create `SessionPathResolver` class with comprehensive path validation
   - [x] Implement path normalization and boundary checking
   - [x] Add symlink resolution and security checks
   - [x] Create comprehensive test suite for path edge cases

3. [x] **Create Session File Operation Tools**: ✅ **COMPLETE**

   - [x] Implement `session_read_file` tool with session path enforcement
   - [x] Implement `session_write_file` tool with atomic write operations
   - [x] Implement `session_delete_file` tool with safety checks
   - [x] Implement `session_list_dir` tool for directory operations
   - [x] Implement `session_exists` tool for file existence checking
   - [x] Implement `session_create_dir` tool for directory creation
   - [x] Implement `session_info` tool for session context information
   - [x] Add proper Zod schemas for all tool parameters

4. [x] **Enhance Session Context Management**: ✅ **COMPLETE**

   - [x] Create `SessionWorkspaceService` for session context management
   - [x] Implement session lookup by name or task ID
   - [x] Add session validation and workspace path resolution
   - [x] Integrate with existing SessionDB/SessionProviderInterface

5. [x] **MCP Integration**: ✅ **COMPLETE**

   - [x] Create adapter layer in `src/adapters/mcp/session-files.ts`
   - [x] Register session file tools in MCP server initialization
   - [x] Implement proper error handling for all error types
   - [x] Add comprehensive tool descriptions and schemas

6. [ ] **Testing and Validation**: ⚠️ **CRITICAL - BLOCKING COMPLETION**

   - [ ] **Fix failing test imports and logger issues** ⚠️ **BLOCKING**
   - [ ] Add comprehensive integration tests with MCP client
   - [ ] Test with actual AI agent interactions
   - [ ] Verify isolation with various path attack scenarios
   - [ ] Performance testing and validation

7. [ ] **Documentation and Migration**: 📚 **NEEDS COMPLETION**

   - [ ] Document MCP session tools and their usage patterns
   - [ ] Create migration guide from standard tools to session tools
   - [ ] Update session workflow documentation
   - [ ] Create usage examples for AI agents

## Verification

- [x] **All file operations through MCP are correctly scoped to the session workspace** ✅ **IMPLEMENTED**
- [x] **Relative paths in tool calls are properly resolved within the session context** ✅ **IMPLEMENTED**
- [x] **Attempted operations outside the session workspace are blocked or redirected** ✅ **IMPLEMENTED**
- [ ] **Performance is acceptable with no significant resource overhead** ❌ **NOT TESTED**
- [ ] **AI agents can seamlessly interact with the session-scoped MCP without special handling** ❌ **NOT TESTED**
- [ ] **No file operations can accidentally leak out to modify the main workspace** ⚠️ **NEEDS VERIFICATION TESTING**
- [ ] **Documentation clearly explains the architecture and usage** ❌ **NOT CREATED**

## Completion Criteria

### 🎯 **Minimum Viable Product (Ready for Use)**

- [x] Core session file tools implemented and working
- [x] Path resolution and security validation functional
- [ ] **Critical test failures fixed** ⚠️ **BLOCKING COMPLETION**
- [ ] **Basic integration tests passing** ❌ **REQUIRED**
- [ ] **Minimal API documentation created** ❌ **REQUIRED**

### 🚀 **Full Feature Set (Production Ready)**

- [ ] Comprehensive test suite with security validation
- [ ] Complete documentation with migration guides
- [ ] Performance testing and optimization
- [ ] AI agent compatibility validation

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

## Architecture Decision Records

1. **ADR-001**: Chose MCP File Operation Proxy over per-session servers for resource efficiency
2. **ADR-002**: Implemented abstraction layer to support future non-filesystem workspaces
3. **ADR-003**: Used existing ProjectContext pattern for session information propagation
4. **ADR-004**: Aligned with domain-driven design by keeping file operations in adapter layer

## Correct Architecture: Single Persistent MCP Server

### **Workflow**

```
1. User starts: `minsky mcp start` (persistent server)
2. User opens Cursor (connects to MCP server)
3. User tells AI: "Work on task #049"
4. AI agent uses session tools with explicit session parameters
```

### **Session Tool Architecture**

```
Persistent MCP Server
├── session_read_file(session="task#049", path="...")
├── session_write_file(session="task#067", path="...")
├── session_list_dir(session="task#049", path="...")
└── [All tools route based on session parameter]
```

### **Key Design Principles**

- **Single MCP Server**: One persistent process, no per-session servers
- **Explicit Session Parameters**: Security feature, not limitation
- **Session Routing**: Tools validate and route based on session parameter
- **Path Isolation**: All file operations restricted to session workspace
