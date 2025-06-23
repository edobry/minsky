# Cursor Tool Gap Analysis

## Executive Summary

This document provides a comprehensive comparison between Minsky's currently implemented session tools and Cursor's complete toolset. It identifies gaps, prioritizes missing tools based on criticality for AI coding workflows, and provides implementation recommendations.

## Current State vs. Target State

### Tools Already Implemented in Minsky ✅

| Tool | Minsky Implementation | Cursor Equivalent | Status |
|------|----------------------|-------------------|---------|
| `session_read_file` | Read file contents with line ranges | `read_file` | ✅ Complete |
| `session_write_file` | Write content to files | N/A (uses `edit_file`) | ✅ Complete |
| `session_delete_file` | Delete files | `delete_file` | ✅ Complete |
| `session_list_directory` | List directory contents | `list_dir` | ✅ Complete |
| `session_file_exists` | Check file existence | N/A | ✅ Complete |
| `session_create_directory` | Create directories | N/A | ✅ Complete |

### Missing Tools Gap Analysis 🔴

| Cursor Tool | Criticality Score | Implementation Complexity | Session Relevance | Priority |
|-------------|------------------|--------------------------|-------------------|----------|
| `edit_file` | 10/10 | Medium | HIGH | **CRITICAL** |
| `search_replace` | 9/10 | Low | HIGH | **CRITICAL** |
| `grep_search` | 9/10 | Low | HIGH | **CRITICAL** |
| `codebase_search` | 8/10 | High | HIGH | **HIGH** |
| `file_search` | 7/10 | Medium | HIGH | **HIGH** |
| `run_terminal_cmd` | 8/10 | Medium | HIGH | **HIGH** |
| `reapply` | 3/10 | Low | MEDIUM | **LOW** |
| `web_search` | 5/10 | Low | NONE | **OPTIONAL** |
| `fetch_pull_request` | 6/10 | Medium | LOW | **OPTIONAL** |
| `fetch_github_issue` | 6/10 | Medium | LOW | **OPTIONAL** |
| `create_diagram` | 4/10 | Low | NONE | **OPTIONAL** |
| `edit_notebook` | 4/10 | High | HIGH | **LOW** |
| `fetch_rules` | 7/10 | Low | MEDIUM | **MEDIUM** |

## Detailed Gap Analysis

### 1. CRITICAL PRIORITY TOOLS (Must Have)

#### `edit_file` → `session_edit_file`
- **Why Critical**: Core functionality for AI code modifications
- **What's Missing**: The `// ... existing code ...` pattern for partial file edits
- **Implementation**: Medium complexity - requires parsing and contextual replacement
- **Dependencies**: None
- **Estimated Effort**: 2-3 days

#### `search_replace` → `session_search_replace`
- **Why Critical**: Essential for large file modifications (>2500 lines)
- **What's Missing**: Single occurrence replacement with context matching
- **Implementation**: Low complexity - string matching with context
- **Dependencies**: None
- **Estimated Effort**: 1 day

#### `grep_search` → `session_grep_search`
- **Why Critical**: Fast pattern matching across codebase
- **What's Missing**: Regex search with include/exclude patterns
- **Implementation**: Low complexity - wrap ripgrep
- **Dependencies**: ripgrep binary
- **Estimated Effort**: 1-2 days

### 2. HIGH PRIORITY TOOLS (Should Have)

#### `codebase_search` → `session_codebase_search`
- **Why Important**: Semantic understanding of code
- **What's Missing**: Embedding-based semantic search
- **Implementation**: High complexity - requires embedding infrastructure
- **Dependencies**: 
  - Embedding model (e.g., sentence-transformers)
  - Vector database (e.g., Qdrant)
  - Indexing pipeline
- **Estimated Effort**: 1-2 weeks

#### `file_search` → `session_file_search`
- **Why Important**: Quick file navigation
- **What's Missing**: Fuzzy file path matching
- **Implementation**: Medium complexity - fuzzy matching algorithm
- **Dependencies**: None (can implement in pure Python/TypeScript)
- **Estimated Effort**: 2-3 days

#### `run_terminal_cmd` → `session_run_command`
- **Why Important**: Execute build/test commands
- **What's Missing**: Command execution with proper pwd context
- **Implementation**: Medium complexity - PTY handling
- **Dependencies**: node-pty or Python pty library
- **Estimated Effort**: 3-4 days

### 3. MEDIUM PRIORITY TOOLS

#### `fetch_rules` → `session_fetch_rules`
- **Why Useful**: Access session-specific rules
- **What's Missing**: Rule retrieval from session workspace
- **Implementation**: Low complexity
- **Dependencies**: None
- **Estimated Effort**: 1 day

### 4. LOW PRIORITY TOOLS

#### `reapply`
- **Why Low**: Edge case for failed edits
- **Session Relevance**: Medium
- **Implementation**: Low complexity
- **Estimated Effort**: 1 day

#### `edit_notebook`
- **Why Low**: Specialized use case
- **Session Relevance**: High (if working with notebooks)
- **Implementation**: High complexity
- **Estimated Effort**: 1 week

### 5. OPTIONAL TOOLS (No Session Variant Needed)

These tools don't require session-aware versions:

- `web_search` - External API, no workspace interaction
- `fetch_pull_request` - Repository-level operation
- `fetch_github_issue` - Repository-level operation
- `create_diagram` - UI rendering only

## Implementation Roadmap

### Phase 1: Critical Tools (Week 1)
1. **Day 1-2**: Implement `session_search_replace`
   - Simple string replacement with context
   - Test with large files
   
2. **Day 2-3**: Implement `session_grep_search`
   - Integrate ripgrep
   - Add include/exclude patterns
   
3. **Day 4-5**: Implement `session_edit_file`
   - Parse `// ... existing code ...` pattern
   - Implement contextual replacement

### Phase 2: Essential Search (Week 2)
1. **Day 1-2**: Implement `session_file_search`
   - Fuzzy matching algorithm
   - Path-based search
   
2. **Day 3-5**: Implement `session_run_command`
   - PTY integration
   - Session context management

### Phase 3: Advanced Search (Week 3-4)
1. **Week 3**: Infrastructure for `session_codebase_search`
   - Set up embedding model
   - Configure vector database
   - Create indexing pipeline
   
2. **Week 4**: Implement `session_codebase_search`
   - Query interface
   - Result ranking
   - Performance optimization

### Phase 4: Nice-to-Have (Week 5+)
- `session_fetch_rules`
- `reapply` functionality
- `edit_notebook` (if needed)

## Resource Requirements

### Development Resources
- **Developers**: 1-2 full-time developers
- **Time**: 4-5 weeks for complete implementation
- **Skills**: Python/TypeScript, MCP protocol, system programming

### Infrastructure Requirements
- **For Basic Tools**: None (use existing libraries)
- **For Semantic Search**:
  - GPU for embedding generation (optional but recommended)
  - Vector database instance
  - ~1-2GB storage per million lines of code

### External Dependencies
- **ripgrep**: For pattern matching (MIT license)
- **node-pty** or Python pty: For terminal execution
- **sentence-transformers**: For embeddings (Apache 2.0)
- **Qdrant** or similar: For vector search (Apache 2.0)

## Risk Assessment

### Technical Risks
1. **Semantic Search Complexity**: High infrastructure requirements
   - *Mitigation*: Start with simpler keyword-based search
   
2. **Cross-platform Compatibility**: PTY behavior varies
   - *Mitigation*: Focus on Linux/macOS first
   
3. **Performance at Scale**: Search operations on large codebases
   - *Mitigation*: Implement caching and incremental indexing

### Implementation Risks
1. **Scope Creep**: Trying to match Cursor exactly
   - *Mitigation*: Focus on core functionality first
   
2. **Integration Complexity**: Ensuring all tools work together
   - *Mitigation*: Comprehensive integration testing

## Recommendations

### Immediate Actions (This Week)
1. **Start with Critical Tools**: Focus on `edit_file`, `search_replace`, and `grep_search`
2. **Set up Development Environment**: Install ripgrep, configure test repositories
3. **Create Test Suite**: Comprehensive tests for each tool

### Short-term (Next Month)
1. **Complete Phase 1 & 2**: All critical and high-priority tools
2. **Begin Semantic Search Research**: Evaluate embedding models and vector databases
3. **User Testing**: Get feedback on implemented tools

### Long-term (Next Quarter)
1. **Implement Advanced Features**: Semantic search if justified by usage
2. **Performance Optimization**: Caching, indexing improvements
3. **Cross-platform Support**: Ensure Windows compatibility

## Success Metrics

1. **Feature Parity**: 80% of critical Cursor tools implemented
2. **Performance**: Search operations complete in <500ms for average codebase
3. **Reliability**: 99.9% success rate for file operations
4. **User Satisfaction**: AI agents can perform common coding tasks without errors

## Conclusion

The gap analysis reveals that Minsky has successfully implemented basic file operations but lacks critical editing and search capabilities that make Cursor effective for AI-assisted coding. By focusing on the three critical tools (`edit_file`, `search_replace`, `grep_search`) and two high-priority search tools (`file_search`, `run_terminal_cmd`), we can achieve 80% feature parity with minimal infrastructure requirements.

The most challenging component is semantic search, which should be deferred until basic functionality is proven and user demand justifies the infrastructure investment. 
