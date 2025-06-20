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

## Docker Containerization Impact

**Critical Context**: Plans are underway to run session workspaces in Docker containers (initially local, then remote). This fundamentally changes the architecture requirements:

1. **Deployment Model**: Sessions will run in isolated Docker containers
2. **Network Boundaries**: File operations must cross container boundaries via APIs
3. **Resource Constraints**: Solutions must minimize per-container overhead
4. **Remote Future**: Architecture must work with remote/distributed containers

### Docker Architecture Analysis

Four approaches were evaluated specifically for Docker compatibility:

1. **MCP File Operation Proxy** ⭐ **OPTIMAL for Docker**
   - Single MCP server routes to container-specific APIs
   - No per-container MCP overhead
   - Natural support for remote containers
   - Security isolation by design

2. **Session-Specific MCP Instances** ❌ **POOR for Docker**
   - Requires MCP server in each container
   - Port management nightmare across containers
   - Resource waste and network complexity

3. **Virtual Filesystem** ❓ **COMPLEX for Docker**
   - Could work with container volume mounts
   - Significant performance and complexity overhead

4. **Centralized Router** ⭐ **GOOD for Docker**
   - Single endpoint for AI agents
   - Natural session-to-container mapping
   - Risk of single point of failure

### Selected Approach: Hybrid MCP Proxy with Container API

Based on Docker requirements, we're implementing a **Hybrid Architecture** combining MCP File Operation Proxy with Centralized Router:

```
AI Agent → MCP Server → Session Router → File Operation Proxy → Container API → Docker Container
```

**Key Benefits for Docker:**
- **Zero container overhead** - no MCP servers in containers
- **Remote container ready** - API-based communication
- **Port management free** - single MCP endpoint
- **Security isolation** - containers isolated by design
- **Location transparency** - containers can be local or remote

### Current System Behavior

The core issue stems from how AI coding agents interact with the filesystem:

1. Tools like `edit_file` resolve paths relative to the main workspace root
2. Even when an AI agent believes it's operating in a session directory, its file operations may target the main workspace
3. This creates an inherent conflict with Minsky's strict session isolation requirements
4. The current approach relies solely on rule-based enforcement, which is prone to human error and isn't technically enforced

### Approaches Considered

Multiple approaches were evaluated during analysis:

1. **MCP File Operation Proxy** (Recommended): Add file operation tools that enforce session boundaries
   - **Pros**: Direct control, transparent to AI agents, automatic path redirection
   - **Cons**: Requires AI to use MCP tools, may need Cursor configuration

2. **Session-Specific Tools**: Create tools with `session_` prefix requiring explicit session parameters
   - **Pros**: Clear separation, explicit context, incremental implementation
   - **Cons**: Requires AI agents to use different tools, more verbose usage

3. **Session-Specific MCP Instances**: Launch dedicated MCP servers per session
   - **Pros**: Strong isolation, clear boundaries
   - **Cons**: Resource overhead, port management complexity

4. **Virtual Filesystem**: Create virtualized filesystem layer
   - **Pros**: Most robust approach, handles all edge cases
   - **Cons**: Most complex implementation, significant changes required

## Requirements

1. **MCP File Operation Tools (Docker-Aware)**

   - Create a comprehensive set of file operation tools in the MCP server
   - Tools should mirror common AI agent operations: `file.read`, `file.write`, `file.edit`, `file.delete`, `file.list`
   - All tools must enforce session workspace boundaries automatically
   - Design tools to work through container APIs (not direct filesystem access)
   - Provide transparent path resolution that works with both relative and absolute paths

2. **Session-to-Container Routing**

   - Implement session context router that maps session IDs to container endpoints
   - Support both local and remote container deployment scenarios
   - Handle container lifecycle events (start, stop, migration)
   - Provide fallback mechanisms for container unavailability
   - Cache container routing information for performance

3. **Container File Operation API**

   - Design REST/gRPC API for file operations within containers
   - Implement secure authentication and authorization for container access
   - Support atomic file operations to prevent corruption
   - Handle file streaming for large files
   - Provide clear error responses for boundary violations

4. **Path Resolution Safety (Container-Aware)**

   - Implement a robust `SessionPathResolver` class that:
     - Converts all paths to absolute paths within the session workspace
     - Validates paths don't escape session boundaries (no `../` traversal attacks)
     - Handles container-specific path mappings and mount points
     - Works with both local and remote container scenarios
   - Provide clear, actionable error messages for path violations
   - Log all path resolutions for debugging and audit purposes

5. **Session Context Integration**

   - Extend the existing `ProjectContext` to include session and container information
   - Pass session context through MCP server initialization
   - Support session-to-container mapping through configuration or service discovery
   - Handle container migration scenarios gracefully

6. **Cursor API Compatibility**

   - Ensure MCP tools are compatible with Cursor's expected file operation patterns
   - Provide tool descriptions that guide AI agents to use MCP tools over native tools
   - Maintain familiar tool interfaces while adding container routing underneath
   - Document how to configure Cursor to prioritize MCP tools

7. **Container Lifecycle Management**

   - Integrate with session management to handle container creation and destruction
   - Support container health checks and recovery mechanisms
   - Handle container migration and failover scenarios
   - Provide monitoring and observability for container operations

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

## Advanced Use Cases Support

This approach supports several advanced usage scenarios:

1. **Multiple Cursor instances on different repos**: Each can specify session context via MCP initialization
2. **Single Cursor with multiple tabs**: MCP server respects the session context per operation
3. **Different agents isolated on same repo**: Each agent's MCP connection includes session context
4. **Multiple agents collaborating in same session**: Shared session context ensures coordination
5. **Remote/K8s deployments**: Central MCP server with session routing based on context

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

## Work Log

- 2024-07-14: Initial analysis performed (session-specific tools approach)
- 2024-07-14: Revised approach to focus on explicit session-specific tools
- 2025-06-18: Comprehensive re-analysis performed with focus on architectural alignment
- 2025-06-18: Selected MCP File Operation Proxy approach for better future compatibility
- 2025-06-18: Updated specification with abstraction layer design for non-filesystem workspaces
- 2025-06-17: Discovered Docker containerization plans and previous work conflicts
- 2025-06-17: Performed Docker compatibility analysis for all approaches
- 2025-06-17: Documented analysis findings without making architectural decision

## Additional Analysis: Docker Containerization Impact

### Context: Future Docker Deployment

**Critical Discovery**: Plans are underway to run session workspaces in Docker containers (initially local, then remote). This fundamentally changes the architecture evaluation:

1. **Deployment Model**: Sessions will run in isolated Docker containers
2. **Network Boundaries**: File operations must cross container boundaries
3. **Resource Constraints**: Solutions must minimize per-container overhead  
4. **Remote Future**: Architecture must work with distributed containers

### Previous Work Investigation

**Found**: Earlier analysis (May 2025) on this same task evaluated similar approaches but selected the **"Session-Specific Tools"** approach:
- Tools like `session_edit_file`, `session_read_file` with explicit session parameters
- Centralized MCP server with session routing
- Strict path validation to prevent boundary violations

This approach was documented through several commits:
- `b5d2b4b9`: Initial design analysis phase
- `6dabc700`: Refined to session-specific tools  
- `4d93d2ab`: Added Cursor rule requirement

### Docker Compatibility Analysis

Evaluated how each approach handles Docker containerization:

#### 1. **MCP File Operation Proxy**
```
AI Agent → MCP Proxy → Container API → Docker Container
```
**Docker Pros:**
- Natural container boundary enforcement
- Minimal container overhead (no MCP in containers)
- Remote container support out of the box
- Security isolation by design

**Docker Cons:**
- Requires container API design
- More complex proxy implementation

#### 2. **Session-Specific Tools** (Previous Work)
```
AI Agent → MCP Server → session_edit_file(session_id) → Container
```
**Docker Pros:**
- Clear session context through parameters
- Explicit container routing by session ID
- Can work with centralized MCP + container APIs

**Docker Cons:**
- Requires AI agents to use different tool names
- More verbose tool usage patterns

#### 3. **Per-Session MCP Instances**
```
AI Agent → Container 1 MCP (port 1234), Container 2 MCP (port 1235)
```
**Docker Pros:**
- Strong isolation per container

**Docker Cons:**
- Port management nightmare across containers
- Resource waste (MCP server per container)
- Network complexity for remote deployment
- **Poor fit for Docker scenarios**

#### 4. **Virtual Filesystem**
```
AI Agent → Virtual FS → Container Volume Mounts
```
**Docker Pros:**
- Clean abstraction layer

**Docker Cons:**
- Most complex implementation
- Performance overhead with container I/O
- Volume management complexity

### Architecture Decision Pending

**Status**: Analysis complete, but architectural decision still pending.

**Key Questions for Decision:**
1. Should we proceed with the previous session-specific tools approach?
2. Should we pivot to MCP proxy approach given Docker requirements?
3. Should we design a hybrid combining both approaches?
4. What are the priorities: immediate implementation vs. Docker-readiness?

**Recommendation**: Evaluate both approaches with Docker prototype to make informed decision.
