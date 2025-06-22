# Cursor Built-in Tools Analysis

## Overview

This document provides a comprehensive analysis of all built-in tools available in the Cursor AI coding assistant environment. These tools are automatically available to AI agents when working within Cursor, and this analysis will help determine which tools should be replicated or adapted for the Minsky session-aware MCP server to provide an equivalent development environment.

## Tool Categories

### 1. File Operations Tools

#### 1.1 `read_file`

- **Purpose**: Read contents of a file with optional line range specification
- **Key Features**:
  - Line range specification (250 lines max per call)
  - Supports both relative and absolute paths
  - Can read entire file (should be used sparingly)
  - Provides summary of omitted content
- **Session Awareness Needs**: HIGH - Currently resolves paths relative to main workspace, needs session workspace context
- **Implementation Priority**: Already implemented as `session_read_file` ✅

#### 1.2 `edit_file`

- **Purpose**: Propose edits to existing files or create new files
- **Key Features**:
  - Uses `// ... existing code ...` pattern for unchanged sections
  - Supports file creation
  - Single edit per file per call
  - Requires context for ambiguity resolution
- **Session Awareness Needs**: HIGH - Must enforce session workspace boundaries
- **Implementation Priority**: Critical - needs session-aware version (could be `session_edit_file`)

#### 1.3 `search_replace`

- **Purpose**: Replace ONE occurrence of text in a file
- **Key Features**:
  - Requires unique string identification with 3-5 lines context
  - Only replaces single occurrence
  - Preferred for large files (>2500 lines)
- **Session Awareness Needs**: HIGH - Must operate within session boundaries
- **Implementation Priority**: High - needs session-aware version

#### 1.4 `delete_file`

- **Purpose**: Delete a file at specified path
- **Key Features**:
  - Fails gracefully if file doesn't exist
  - Security restrictions may apply
- **Session Awareness Needs**: HIGH - Must be restricted to session workspace
- **Implementation Priority**: Already implemented as `session_delete_file` ✅

#### 1.5 `reapply`

- **Purpose**: Reapply last edit with smarter model if initial application failed
- **Key Features**:
  - Only used immediately after edit_file
  - Indicates model comprehension issues
- **Session Awareness Needs**: MEDIUM - Depends on underlying edit operation
- **Implementation Priority**: Low - edge case tool

### 2. Code Search & Analysis Tools

#### 2.1 `codebase_search`

- **Purpose**: Semantic search across codebase
- **Key Features**:
  - Semantic matching (not exact text)
  - Directory filtering with glob patterns
  - Results include relevance scores
- **Session Awareness Needs**: HIGH - Should search within session workspace only
- **Implementation Priority**: High - needs session-aware version

#### 2.2 `grep_search`

- **Purpose**: Fast regex pattern matching
- **Key Features**:
  - Exact text/regex matching
  - Include/exclude file patterns
  - Case sensitivity options
  - Results capped at 50 matches
- **Session Awareness Needs**: HIGH - Should search within session workspace only
- **Implementation Priority**: High - needs session-aware version

#### 2.3 `file_search`

- **Purpose**: Fuzzy search for files by partial name
- **Key Features**:
  - Fuzzy matching on file paths
  - Results capped at 10
- **Session Awareness Needs**: HIGH - Should search within session workspace only
- **Implementation Priority**: Medium - needs session-aware version

#### 2.4 `list_dir`

- **Purpose**: List directory contents for exploration
- **Key Features**:
  - Shows files and directories
  - Includes file sizes
  - Good for initial discovery
- **Session Awareness Needs**: HIGH - Must list session workspace directories
- **Implementation Priority**: Already implemented as `session_list_directory` ✅

### 3. External Integration Tools

#### 3.1 `web_search`

- **Purpose**: Search web for real-time information
- **Key Features**:
  - Returns snippets and URLs
  - Good for current information
- **Session Awareness Needs**: NONE - External tool, no workspace interaction
- **Implementation Priority**: Low - could be useful but not session-specific

#### 3.2 `fetch_pull_request`

- **Purpose**: Fetch PR or commit information from GitHub
- **Key Features**:
  - Returns diff and metadata
  - Supports multiple repositories
  - May timeout if GitHub not connected
- **Session Awareness Needs**: LOW - Repository context might be relevant
- **Implementation Priority**: Medium - useful for understanding changes

#### 3.3 `fetch_github_issue`

- **Purpose**: Fetch GitHub issue details
- **Key Features**:
  - Returns issue metadata and content
  - Supports multiple repositories
- **Session Awareness Needs**: LOW - Repository context might be relevant
- **Implementation Priority**: Medium - useful for task context

### 4. Development Tools

#### 4.1 `run_terminal_cmd`

- **Purpose**: Execute terminal commands
- **Key Features**:
  - Requires user approval
  - Supports background processes
  - Maintains shell context between calls
- **Session Awareness Needs**: CRITICAL - Must execute in session workspace directory
- **Implementation Priority**: Critical - needs session-aware version with proper pwd context

#### 4.2 `fetch_rules`

- **Purpose**: Fetch codebase-specific rules and guidelines
- **Key Features**:
  - Returns rule content by name
  - Helps with navigation and code generation
- **Session Awareness Needs**: MEDIUM - Rules might be session-specific
- **Implementation Priority**: Medium - depends on rule storage location

#### 4.3 `create_diagram`

- **Purpose**: Create Mermaid diagrams
- **Key Features**:
  - Renders in chat UI
  - Pre-validates syntax
- **Session Awareness Needs**: NONE - UI rendering tool
- **Implementation Priority**: Low - nice to have but not critical

#### 4.4 `edit_notebook`

- **Purpose**: Edit Jupyter notebook cells
- **Key Features**:
  - Cell-based editing
  - Supports multiple languages
  - Can create new cells
- **Session Awareness Needs**: HIGH - Notebook files in session workspace
- **Implementation Priority**: Low - specialized tool, lower priority

## Tool Origins Analysis

### Likely Tool Sources

1. **Cursor Custom Tools** (High Confidence):

   - `edit_file` - Cursor-specific editing pattern with `// ... existing code ...`
   - `reapply` - Cursor-specific error recovery mechanism
   - `fetch_rules` - Cursor workspace rule system

2. **Standard MCP Tools** (Medium Confidence):

   - File operations (read, write, delete) - Common MCP patterns
   - Search operations - Standard development tool patterns
   - Terminal execution - Common automation pattern

3. **External API Integrations**:
   - `web_search` - Likely uses external search API
   - `fetch_pull_request`, `fetch_github_issue` - GitHub API wrappers

### Evidence for MCP Framework Usage

The tool patterns suggest Cursor is using an MCP (Model Context Protocol) framework because:

- Structured JSON input/output formats
- Consistent parameter patterns
- Tool namespace organization
- Error handling patterns match MCP specifications

## Session-Aware Implementation Requirements

### Critical Tools Needing Session Implementation

1. **File Manipulation**:

   - `session_edit_file` - Edit files within session workspace
   - `session_search_replace` - Replace text within session files
   - ✅ `session_read_file` (already implemented)
   - ✅ `session_write_file` (already implemented)
   - ✅ `session_delete_file` (already implemented)

2. **Search Operations**:

   - `session_codebase_search` - Semantic search within session
   - `session_grep_search` - Pattern matching within session
   - `session_file_search` - Find files within session
   - ✅ `session_list_directory` (already implemented)

3. **Execution**:
   - `session_run_command` - Execute commands in session workspace
   - Needs proper pwd context and environment isolation

### Tools That Don't Need Session Variants

1. **External Tools**:

   - `web_search` - No workspace interaction
   - `create_diagram` - UI rendering only

2. **Repository-Level Tools**:
   - `fetch_pull_request` - Operates at repository level
   - `fetch_github_issue` - Operates at repository level

## Ambiguities and Open Questions

### 1. Tool Implementation Details

- **Q**: Are Cursor's tools using the official MCP SDK or a custom implementation?
- **Need**: Access to Cursor's tool implementation source or documentation

### 2. Tool Behavior Specifications

- **Q**: How does `codebase_search` implement semantic search? (embeddings, LSP, other?)
- **Q**: What model powers the `reapply` functionality?
- **Need**: Detailed behavior specifications for complex tools

### 3. Security and Isolation

- **Q**: How does Cursor enforce security boundaries for `run_terminal_cmd`?
- **Q**: Are there additional security measures beyond user approval?
- **Need**: Security model documentation

### 4. Integration Points

- **Q**: How do tools interact with Cursor's workspace context?
- **Q**: Is there a tool discovery mechanism for AI agents?
- **Need**: Integration architecture documentation

### 5. Performance Considerations

- **Q**: How are large file operations optimized?
- **Q**: What caching mechanisms exist for search operations?
- **Need**: Performance benchmarks and optimization strategies

## Implementation Recommendations

### Phase 1: Critical File Operations (Immediate)

1. Implement `session_edit_file` with same UX as Cursor's `edit_file`
2. Implement `session_search_replace` for large file edits
3. Ensure all path operations enforce session boundaries

### Phase 2: Search and Discovery (High Priority)

1. Implement `session_grep_search` for pattern matching
2. Implement `session_codebase_search` (may need semantic search infrastructure)
3. Implement `session_file_search` for fuzzy file finding

### Phase 3: Command Execution (High Priority)

1. Implement `session_run_command` with proper pwd context
2. Ensure environment isolation between sessions
3. Add security measures for command approval

### Phase 4: Enhanced Features (Medium Priority)

1. Adapt `fetch_rules` for session-specific rules
2. Consider `reapply` functionality for error recovery
3. Add `edit_notebook` if Jupyter support needed

### Phase 5: External Integrations (Low Priority)

1. Consider adding `web_search` for general queries
2. Integrate GitHub tools if needed for workflow

## Success Criteria

A fully equivalent session-aware environment should:

1. ✅ Provide all file operations within session boundaries
2. ⚠️ Support all search operations within session context
3. ⚠️ Execute commands in proper session workspace
4. ⚠️ Maintain security and isolation between sessions
5. ✅ Support remote deployment scenarios
6. ⚠️ Integrate seamlessly with various AI coding agents

## Additional Information Needed

To fully specify the implementation:

1. **Cursor Tool Specifications**: Official documentation or source code
2. **MCP Protocol Version**: Which version of MCP Cursor implements
3. **Security Requirements**: Detailed security model for command execution
4. **Performance Targets**: Expected latency and throughput for operations
5. **AI Agent Integration**: How different agents discover and use tools
6. **Remote Deployment**: Specific requirements for containerized environments
