# Task #049: Implement Session-Scoped MCP Server for Workspace Isolation

## Context

The current Minsky workflow heavily relies on the `session-first-workflow.mdc` rule to ensure AI coding agents only modify files within session workspaces. However, AI agents frequently use relative paths with the `edit_file` tool, resulting in unintended modifications to the main workspace. This violates the core principle that all task-related changes must occur exclusively within session workspaces.

Minsky has recently added MCP (Model Context Protocol) support, providing an opportunity to implement proper workspace isolation at the tooling level rather than relying solely on rule-based enforcement.

## Updated Analysis

After comprehensive analysis of the current architecture and future direction:

1. **Root Cause**: AI tools resolve relative paths against the main workspace, not the session workspace
2. **Architecture Alignment**: Solution must align with domain-driven design and interface-agnostic patterns
3. **Incremental Implementation**: Start with local filesystem, prepare for future containerization
4. **Pattern Consistency**: Should follow "preventing bypass patterns" architectural principles

## Selected Approach: Session-Aware Tools + Local Filesystem

Based on analysis and the need for incremental implementation, we're implementing **Session-Aware Tools** with local filesystem access as Phase 1:

- Tools with explicit session context: `session_edit_file(session, path, content)`
- Single centralized MCP server with session routing
- Direct filesystem access to existing session directories
- Foundation for future containerization without interface changes

### Architecture Flow

```
AI Agent → MCP Client → session_edit_file(session, path, content) → 
Central MCP Server → Session Lookup → Path Resolution → Local Filesystem
```

**Key Benefits:**
- **Immediate Value**: Solves path resolution issues today
- **Session Context Explicit**: Prevents accidental workspace violations
- **Future-Proof**: Same interface works with containers later
- **No New Infrastructure**: Uses existing session directory structure

## Docker Containerization Impact

**Moved to Task #150**: The comprehensive Docker and Kubernetes analysis has been extracted to Task #150 (Design Containerized Session Workspace Architecture) to maintain focus on the immediate implementation.

**Future Compatibility**: The session-aware tools interface designed in this task will work seamlessly with containerized deployments - only the backend implementation will change, not the tool interface.

## Requirements

1. **Session-Aware MCP Tools**

   - Create session-aware file operation tools: `session_edit_file`, `session_read_file`, etc.
   - All tools require explicit session parameter to prevent accidental workspace violations
   - Tools should mirror common AI agent operations for familiarity
   - Design tool interface to work seamlessly with future containerization

2. **Session Resolution and Validation**

   - Integrate with existing `SessionService` to resolve session IDs to workspace directories
   - Validate session exists and is accessible before performing operations
   - Provide clear error messages for invalid or non-existent sessions
   - Support both session names (`task#049`) and alternative identifiers

3. **Path Resolution Safety**

   - Implement robust path resolution within session workspace boundaries
   - Convert relative paths to absolute paths within the session directory
   - Validate paths don't escape session boundaries (prevent `../` attacks)
   - Handle edge cases like symlinks, relative paths, and special characters
   - Log all path resolutions for debugging and audit purposes

4. **Workspace Backend**

   - Create `WorkspaceBackend` service for actual workspace operations
   - Design as abstraction layer to support future containerization
   - Support atomic operations to prevent corruption
   - Handle large content efficiently (streaming, chunking, etc.)
   - Provide consistent error handling and reporting

5. **MCP Server Integration**

   - Add session-aware tools to existing MCP server implementation
   - Use consistent Zod schemas for tool parameter validation
   - Follow existing MCP server patterns and conventions
   - Ensure proper error handling and response formatting

6. **AI Agent Experience**

   - Design tools to encourage session-aware development patterns
   - Provide helpful error messages that guide agents toward correct usage
   - Make session context explicit and impossible to ignore
   - Document tools clearly for AI agent consumption

## Implementation Steps

1. [ ] **Workspace Backend**:

   - [ ] Create `WorkspaceBackend` service with abstraction interface
   - [ ] Implement `LocalWorkspaceBackend` for direct filesystem access
   - [ ] Design interface to support future `ContainerWorkspaceBackend`
   - [ ] Add comprehensive error handling and validation
   - [ ] Create unit tests for workspace operations and boundary enforcement

2. [ ] **Session Path Resolution System**:

   - [ ] Create `SessionPathResolver` class with comprehensive path validation
   - [ ] Implement path normalization and boundary checking
   - [ ] Add symlink resolution and security checks
   - [ ] Handle relative path conversion to absolute within session
   - [ ] Create property-based tests for path edge cases

3. [ ] **Essential Session-Aware MCP Tools**:

   - [ ] Implement `session_edit_file` tool with Zod schema
   - [ ] Implement `session_read_file` tool for file reading
   - [ ] Implement `session_list_dir` for directory operations
   - [ ] Implement `session_delete_file` with safety checks
   - [ ] Add tools to existing MCP server registration

4. [ ] **Session Integration Layer**:

   - [ ] Integrate with existing `SessionService` for session resolution
   - [ ] Add session validation and error handling
   - [ ] Support multiple session identifier formats
   - [ ] Create adapter layer in `src/adapters/mcp/session-workspace.ts`
   - [ ] Wire session-aware tools to use `WorkspaceBackend` abstraction

5. [ ] **Advanced Session Tools**:

   - [ ] Implement `session_grep_search` for text searching within sessions
   - [ ] Create `session_file_search` for filename-based searching
   - [ ] Add `session_codebase_search` if semantic search is available
   - [ ] Ensure consistent parameter patterns across all tools

6. [ ] **Testing and Validation**:

   - [ ] Create integration tests with real session workspaces
   - [ ] Test path boundary enforcement with attack scenarios
   - [ ] Add end-to-end tests with MCP client interactions
   - [ ] Verify session isolation across multiple concurrent sessions
   - [ ] Test error conditions and edge cases

7. [ ] **Documentation and Migration**:

   - [ ] Document session-aware tools and usage patterns
   - [ ] Create migration guide from edit_file to session_edit_file
   - [ ] Add examples for AI agent usage
   - [ ] Update session workflow documentation

## Advanced Use Cases Support

This approach supports several usage scenarios with local filesystem:

1. **Multiple Cursor instances on different repos**: Each specifies session context explicitly
2. **Single Cursor with multiple sessions**: MCP server routes by session parameter
3. **Multiple AI agents on same repo**: Each agent specifies session context
4. **Session isolation**: Perfect isolation between concurrent sessions
5. **Future containerization**: Same interface works when backend changes to containers

## Verification

- [ ] Session-aware tools correctly restrict operations to session workspace
- [ ] Relative paths are correctly resolved within session context  
- [ ] Path traversal attempts are blocked with clear error messages
- [ ] AI agents can use session tools with explicit session parameters
- [ ] Multiple concurrent sessions remain completely isolated
- [ ] Integration works seamlessly with existing Minsky session workflows
- [ ] Performance overhead is minimal (< 10ms per session resolution)
- [ ] Documentation clearly explains session-aware tool usage patterns

## Technical Considerations

- **Security**: Implement defense-in-depth with multiple validation layers
- **Performance**: Cache session lookups and path resolutions where safe
- **Usability**: Make session context explicit and intuitive for AI agents
- **Error Handling**: Follow project's error handling patterns consistently
- **Future Compatibility**: Design backend abstraction for easy containerization
- **Testing**: Create comprehensive tests for boundary enforcement and edge cases

## Workspace Backend

The "backend implementation" mentioned refers to the **Workspace Backend** - an abstraction layer that handles the actual workspace operations:

```typescript
// Abstract interface for future extensibility  
interface WorkspaceBackend {
  readFile(workspaceDir: string, relativePath: string): Promise<string>;
  writeFile(workspaceDir: string, relativePath: string, content: string): Promise<void>;
  deleteFile(workspaceDir: string, relativePath: string): Promise<void>;
  listDirectory(workspaceDir: string, relativePath: string): Promise<string[]>;
  // Future: could add non-file operations like database queries
}

// Current implementation: direct filesystem
class LocalWorkspaceBackend implements WorkspaceBackend {
  async readFile(workspaceDir: string, relativePath: string): Promise<string> {
    const fullPath = this.validatePath(workspaceDir, relativePath);
    return fs.readFile(fullPath, 'utf8');
  }
  // ... other methods
}

// Future implementation: container API calls  
class ContainerWorkspaceBackend implements WorkspaceBackend {
  async readFile(workspaceDir: string, relativePath: string): Promise<string> {
    const containerEndpoint = await this.getContainerEndpoint(workspaceDir);
    const response = await fetch(`${containerEndpoint}/api/workspace/read?path=${relativePath}`);
    return response.text();
  }
  // ... other methods
}

// Future implementation: database-backed workspace
class DatabaseWorkspaceBackend implements WorkspaceBackend {
  async readFile(workspaceDir: string, relativePath: string): Promise<string> {
    // Query database for workspace content instead of filesystem
    return await this.db.getWorkspaceFile(workspaceDir, relativePath);
  }
  // ... other methods
}
```

This follows the same pattern as Minsky's existing task backends (`MarkdownTaskBackend`, `GitHubTaskBackend`, etc.) - an abstraction that allows different implementations while maintaining the same interface.

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #047 (Configure MCP Server in Minsky Init Command)
- Related to task #039 (Prevent Session Creation Within Existing Sessions)
- **Continued in task #150** (Design Containerized Session Workspace Architecture)

## Work Log

- 2024-07-14: Initial analysis performed (session-specific tools approach)
- 2024-07-14: Revised approach to focus on explicit session-specific tools
- 2025-06-18: Comprehensive re-analysis performed with focus on architectural alignment
- 2025-06-18: Selected MCP File Operation Proxy approach for better future compatibility
- 2025-06-18: Updated specification with abstraction layer design for non-filesystem workspaces
- 2025-06-17: Discovered Docker containerization plans and previous work conflicts
- 2025-06-17: Performed Docker compatibility analysis for all approaches
- 2025-06-17: Documented analysis findings without making architectural decision
- 2025-06-17: Simplified scope to local filesystem with session-aware tools (Phase 1)
- 2025-06-17: Extracted Docker/K8s architecture to Task #150
- 2025-06-17: Updated task spec to focus on incremental implementation
- 2025-06-20: Performed senior engineer analysis and created detailed implementation plan

## Detailed Implementation Plan

### 🏗️ **Architecture Overview**

Based on analysis of the current codebase:

1. **MCP Server**: Uses FastMCP v3.3.0 with `MinskyMCPServer` wrapper
2. **CommandMapper**: Extended with category-specific methods (`addSessionCommand`, `addTaskCommand`, etc.)
3. **Project Context**: Already supports repository path context via `ProjectContext` interface
4. **Tool Registration**: Tools are registered via adapter pattern in `src/adapters/mcp/`

### 📋 **Implementation Phases**

#### **Phase 1: Core Infrastructure (2-3 days)**

**1.1 Create Workspace Backend Interface**
```typescript
// src/domain/workspace/workspace-backend.ts
interface WorkspaceBackend {
  readFile(workspaceDir: string, relativePath: string): Promise<string>;
  writeFile(workspaceDir: string, relativePath: string, content: string): Promise<void>;
  deleteFile(workspaceDir: string, relativePath: string): Promise<void>;
  listDirectory(workspaceDir: string, relativePath?: string): Promise<FileInfo[]>;
  exists(workspaceDir: string, relativePath: string): Promise<boolean>;
}
```

**1.2 Implement Local Workspace Backend**
- Create `LocalWorkspaceBackend` implementing direct filesystem operations
- Add comprehensive error handling for file operations
- Include atomic write operations to prevent corruption
- Implement proper cleanup on errors

**1.3 Create Session Path Resolver**
```typescript
// src/domain/session/session-path-resolver.ts
class SessionPathResolver {
  validateAndResolvePath(sessionDir: string, userPath: string): string;
  isPathWithinSession(sessionDir: string, resolvedPath: string): boolean;
  normalizeRelativePath(basePath: string, relativePath: string): string;
}
```

#### **Phase 2: MCP Tool Implementation (3-4 days)**

**2.1 Extend CommandMapper**
```typescript
// Add to CommandMapper
addFileCommand(
  name: string,
  description: string,
  schema: z.ZodType,
  handler: (args: any, context: ProjectContext) => Promise<any>
): void
```

**2.2 Create Session File Tools**
- `session_edit_file`: Edit files within session workspace
- `session_read_file`: Read file contents from session
- `session_list_dir`: List directory contents in session
- `session_delete_file`: Delete files (with safety checks)
- `session_file_search`: Search for files by name pattern
- `session_grep_search`: Search file contents

**2.3 Register Tools in MCP Adapter**
```typescript
// src/adapters/mcp/session-files.ts
export function registerSessionFileTools(commandMapper: CommandMapper): void {
  // Register each tool with proper Zod schemas
}
```

#### **Phase 3: Integration & Safety (2 days)**

**3.1 Session Service Integration**
- Extend `SessionService` to provide session workspace paths
- Add validation for session existence and accessibility
- Implement session workspace locking during operations

**3.2 Security Hardening**
- Implement path traversal attack prevention
- Add symlink resolution and validation
- Create comprehensive blacklist for sensitive paths
- Add rate limiting for file operations

**3.3 Error Handling Enhancement**
- Create specific error types: `SessionNotFoundError`, `PathViolationError`, etc.
- Implement proper error recovery and cleanup
- Add detailed logging for debugging

#### **Phase 4: Testing & Documentation (2 days)**

**4.1 Test Suite**
- Unit tests for `SessionPathResolver` with edge cases
- Integration tests for each MCP tool
- Security tests for path traversal attempts
- Performance tests for large file operations
- End-to-end tests with actual MCP client

**4.2 Documentation**
- API documentation for new tools
- Migration guide from `edit_file` to `session_edit_file`
- Security considerations documentation
- Examples of proper usage patterns

### 🔧 **Technical Decisions**

1. **Tool Naming**: Use `session_` prefix for clarity and discoverability
2. **Parameter Design**: Explicit `session` parameter required (no implicit context)
3. **Path Handling**: All paths relative to session root, absolute paths rejected
4. **Error Messages**: Clear, actionable messages guiding to correct usage
5. **Performance**: Implement caching for session lookups (5-minute TTL)
6. **Compatibility**: Tools work alongside existing non-session tools

### 📊 **Success Metrics**

- Zero path escapes in security testing
- < 10ms overhead for session resolution
- 100% backward compatibility with existing tools
- Clear error messages that guide users to correct usage
- Comprehensive test coverage (>90%)

### 🚀 **Rollout Strategy**

1. **Week 1**: Core infrastructure and basic tools
2. **Week 2**: Complete tool set and security hardening
3. **Week 3**: Testing, documentation, and refinement
4. **Week 4**: Gradual rollout with monitoring

### ⚠️ **Risk Mitigation**

- **Risk**: AI agents continue using old tools
  - **Mitigation**: Clear deprecation warnings, helpful error messages
- **Risk**: Performance impact on file operations
  - **Mitigation**: Caching, efficient path resolution
- **Risk**: Security vulnerabilities
  - **Mitigation**: Multiple validation layers, comprehensive testing
