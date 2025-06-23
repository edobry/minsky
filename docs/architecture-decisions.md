# Architecture Decisions Record (ADR)

This document captures key architectural decisions made during the implementation of session-aware tools, explaining the rationale behind design choices.

## ADR-001: Session-First Architecture

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

AI coding agents need isolated workspaces to prevent cross-contamination between different tasks. Cursor's built-in tools operate on the global workspace, which poses risks in multi-task environments.

### Decision

Implement session-first architecture where all tools require explicit session context and operate within bounded session workspaces.

### Rationale

1. **Isolation**: Prevents accidental cross-task interference
2. **Security**: Limits file system access to designated areas
3. **Scalability**: Supports concurrent task execution
4. **Auditability**: Clear boundaries for operation tracking

### Implementation

```typescript
interface SessionAwareTool {
  session: string;           // Required session context
  // ... tool-specific parameters
}
```

All tools use `SessionPathResolver` to validate and resolve paths within session boundaries.

## ADR-002: Pattern-Based File Editing

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

Cursor's `edit_file` tool allows AI agents to specify partial file modifications using special markers like `// ... existing code ...`. This pattern enables surgical edits without requiring full file rewrites.

### Decision

Implement pattern-based editing with enhanced validation and atomic operations, maintaining Cursor compatibility while adding safety features.

### Rationale

1. **Compatibility**: Maintains existing AI agent workflow patterns
2. **Efficiency**: Avoids full file rewrites for small changes
3. **Safety**: Validates pattern markers before applying edits
4. **Atomicity**: Ensures consistent file state during operations

### Implementation Details

```typescript
// Supported patterns
"// ... existing code ..."     // TypeScript/JavaScript
"# ... existing code ..."      // Python/Shell
"<!-- ... existing code -->"   // HTML/XML
"/* ... existing code */"      // C/Java style
```

**Validation Rules**:
- Pattern markers must match file language
- File must exist when using existing code markers
- New files cannot contain existing code markers
- Multiple patterns supported per edit

## ADR-003: Ripgrep for Search Operations

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

Search operations are critical for AI agent productivity. We needed a fast, reliable search engine for `session_grep_search`.

### Decision

Use ripgrep (rg) as the search engine for `session_grep_search` with fallback to native implementation.

### Rationale

1. **Performance**: Significantly faster than native Node.js regex
2. **Features**: Rich regex support, file filtering, parallel processing
3. **Reliability**: Mature tool with proven track record
4. **Memory Efficiency**: Streaming results, controlled memory usage

### Implementation

```typescript
async function searchWithFallback(query: string, options: SearchOptions) {
  try {
    return await ripgrepSearch(query, options);
  } catch (error) {
    console.warn('Ripgrep unavailable, falling back to native search');
    return await nativeSearch(query, options);
  }
}
```

## ADR-004: Semantic Search with Query Expansion

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

AI agents often search for conceptual understanding rather than exact text matches. Simple string matching fails to capture semantic relationships and programming concepts.

### Decision

Implement semantic search with intelligent query expansion for programming concepts in `session_codebase_search`.

### Query Expansion Examples

| Original Query | Expanded Terms | Rationale |
|---------------|----------------|-----------|
| "error handling" | "try", "catch", "throw", "Error", "exception" | Common patterns |
| "authentication" | "auth", "login", "logout", "session", "token" | Domain concepts |
| "database" | "db", "sql", "query", "connection", "model" | Technical terms |

### Implementation Strategy

1. **Static Expansion**: Predefined mapping of common programming concepts
2. **Context Awareness**: File-type specific expansions
3. **Result Scoring**: Relevance scoring based on expansion matches
4. **Performance Limits**: Bounded expansion to prevent over-matching

## ADR-005: Shell Context Isolation

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

Command execution requires careful isolation to prevent cross-session contamination while maintaining shell context for complex operations.

### Decision

Implement session-aware shell context with isolated working directories and environment inheritance.

### Security Considerations

1. **Working Directory**: Commands execute in session workspace
2. **Environment Variables**: Inherit safe environment variables only
3. **Path Restrictions**: Block access outside session boundaries
4. **Resource Limits**: 30-second timeout, process monitoring

### Implementation

```typescript
class SessionShellManager {
  private sessionWorkspace: string;
  private environment: NodeJS.ProcessEnv;
  
  async executeCommand(command: string, options: ExecutionOptions) {
    return spawn(command, [], {
      cwd: this.sessionWorkspace,           // Isolated working directory
      env: this.sanitizedEnvironment(),     // Filtered environment
      timeout: 30000,                       // Resource limit
    });
  }
}
```

## ADR-006: Cursor Interface Compatibility

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

Existing AI agents depend on Cursor's tool interfaces. Breaking compatibility would require extensive agent rewrites and reduce adoption.

### Decision

Maintain exact parameter and response format compatibility with Cursor tools while adding session-awareness.

### Migration Strategy

**Minimal Changes Required**:
```typescript
// Before (Cursor)
await edit_file({
  target_file: "src/main.ts",
  instructions: "Add logging",
  code_edit: "console.log('debug');"
});

// After (Minsky)
await session_edit_file({
  session: "task-123",              // Only addition
  path: "src/main.ts",             // Renamed for clarity
  instructions: "Add logging",
  content: "console.log('debug');" // Renamed for clarity
});
```

## ADR-007: Comprehensive Error Handling

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

Robust error handling is critical for AI agent reliability. Users need clear, actionable error messages to diagnose and resolve issues.

### Decision

Implement comprehensive error handling with structured error responses and detailed context.

### Error Categories

1. **Session Errors**: Invalid or missing session context
2. **Path Errors**: File system boundary violations  
3. **Operation Errors**: Tool-specific failures (file not found, command failed)
4. **Security Errors**: Unauthorized access attempts
5. **Resource Errors**: Timeouts, memory limits, etc.

### Error Response Format

```typescript
interface ErrorResponse {
  success: false;
  error: string;           // Human-readable message
  session: string;         // Session context
  details?: any;          // Additional context
}
```

## ADR-008: MCP Server Integration

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

The session-aware tools need to be discoverable and callable through Minsky's MCP server interface.

### Decision

Integrate all session-aware tools into the existing MCP server architecture with proper tool registration and schema validation.

### Implementation

```typescript
// In /src/commands/mcp/index.ts
import { registerSessionFileTools } from '../../adapters/mcp/session-file-tools.js';
import { registerSessionSearchTools } from '../../adapters/mcp/session-search-tools.js';
import { registerSessionCommandTools } from '../../adapters/mcp/session-command-tools.js';

// Register all session-aware tools
registerSessionFileTools(server);
registerSessionSearchTools(server);
registerSessionCommandTools(server);
```

## ADR-009: Validation Framework

**Status**: Accepted  
**Date**: 2024-12-23  

### Context

With 8 different session-aware tools, we needed a systematic way to validate their implementation and ensure they meet requirements.

### Decision

Create a comprehensive validation framework that tests all tools against defined criteria.

### Validation Categories

1. **Schema Validation**: Parameter and response format compliance
2. **Security Validation**: Session boundary enforcement
3. **Functionality Validation**: Core operations work correctly
4. **Integration Validation**: MCP server integration

### Implementation

Created `session-tools-validation.ts` with systematic validation for all tools:

```typescript
interface ValidationResult {
  toolName: string;
  success: boolean;
  errors: string[];
  warnings: string[];
}
```

## Decision Impact Summary

| Decision | Security Impact | Compatibility Impact | Implementation Complexity |
|----------|-----------------|---------------------|---------------------------|
| Session-first architecture | ✅ High security | ⚠️ Breaking change | Medium |
| Pattern-based editing | ✅ Validates patterns | ✅ Full compatibility | Low |
| Ripgrep search | ✅ Sandboxed execution | ✅ Same interface | Medium |
| Semantic search | ✅ No security risk | ✅ Enhanced results | High |
| Shell isolation | ✅ Complete isolation | ✅ Same interface | High |
| Cursor compatibility | ✅ Maintains security | ✅ Easy migration | Medium |
| Error handling | ✅ Prevents info leaks | ✅ Clear messages | Low |
| MCP integration | ✅ Server-level security | ✅ Standard interface | Low |
| Validation framework | ✅ Ensures security | ✅ Ensures compatibility | Medium |

## Lessons Learned

### What Worked Well

1. **Incremental Development**: Building in phases (file ops → search → commands) allowed for early validation
2. **Compatibility First**: Maintaining Cursor compatibility reduced integration friction
3. **Security by Design**: Session boundaries enforced from the start prevented security issues
4. **Comprehensive Testing**: Validation framework caught issues early

### What Could Be Improved

1. **Documentation**: Should have been written alongside implementation
2. **Performance Testing**: Need real-world benchmarks rather than assumptions
3. **Error Messages**: Could be more specific about recovery actions
4. **Caching Strategy**: Opportunities for intelligent caching not fully explored

## Future Architectural Considerations

### Potential Enhancements

1. **Distributed Execution**: Multi-process tool execution for better isolation
2. **Advanced Caching**: Intelligent caching based on usage patterns  
3. **Real-time Collaboration**: Multi-agent session coordination
4. **Plugin Architecture**: Allow third-party tool extensions

### Maintenance Strategy

This architecture will be continuously evaluated and refined based on:

- **Usage Patterns**: How AI agents actually use the tools
- **Security Incidents**: Any security issues discovered
- **Performance Issues**: Real-world performance problems
- **Compatibility Feedback**: Agent developer experience

The architecture decisions documented here represent the current state of implementation and will evolve as the system matures and new requirements emerge. 
