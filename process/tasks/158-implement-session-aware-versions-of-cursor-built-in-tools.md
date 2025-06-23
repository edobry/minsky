# Implement Session-Aware Versions of Cursor Built-in Tools

## Context

Cursor provides a comprehensive set of built-in tools that enable AI coding agents to interact with the development environment. These tools include file operations, code search, terminal execution, and external integrations. However, these tools operate in the context of the main workspace, which conflicts with Minsky's session-based workflow where all task-related changes must occur within isolated session workspaces.

A comprehensive analysis of Cursor's built-in tools has been documented in [docs/cursor-built-in-tools-analysis.md](../../docs/cursor-built-in-tools-analysis.md). This task will implement session-aware versions of the relevant tools to provide AI coding agents with a fully equivalent environment that enforces session workspace isolation.

**IMPORTANT**: This task requires extensive research and analysis to understand the exact nature, origins, and implementations of Cursor's built-in tools before proceeding with implementation.

## Research and Analysis Requirements

### 1. Tool Origin Investigation

**CRITICAL**: Before implementing any tools, conduct comprehensive research to identify the specific libraries, frameworks, and systems that Cursor's tools originate from:

#### Research Questions to Answer:

1. **Are these custom Cursor implementations** or adaptations of open-source MCP tools?
2. **Which specific MCP libraries or frameworks** does Cursor likely use?
3. **Are any tools based on Language Server Protocol (LSP)** implementations?
4. **Do any tools use established libraries** (e.g., ripgrep for `grep_search`, fzf for `file_search`)?
5. **What semantic search technology** does `codebase_search` likely use? (embeddings, AST analysis, etc.)
6. **Is `run_terminal_cmd` using established libraries** like node-pty, xterm.js, or custom implementations?
7. **Do external integration tools** (`web_search`, `fetch_pull_request`) use specific APIs or services?

#### Research Methods:

- **Web research** on Cursor's architecture and tooling
- **MCP protocol documentation** and available tool libraries
- **GitHub repository analysis** of related open-source tools
- **Community forums and documentation** about Cursor's implementation
- **Technical blog posts** or talks by Cursor team
- **Comparison with other AI coding assistants** (GitHub Copilot, Codeium, etc.)

#### Deliverable:

Create a detailed mapping document: `docs/cursor-tool-origins-analysis.md` containing:

- Identified source libraries/frameworks for each tool
- Confidence level for each identification (High/Medium/Low/Unknown)
- Alternative implementation approaches when source is unknown
- Licensing and compatibility considerations
- Integration complexity assessment

### 2. Deep Tool Analysis and Comparison

For each Cursor tool, conduct detailed analysis:

#### Individual Tool Investigation:

1. **Exact parameter schemas** - What parameters does each tool accept?
2. **Return value formats** - What data structures are returned?
3. **Error handling patterns** - How do tools handle edge cases?
4. **Performance characteristics** - What are latency and throughput expectations?
5. **Usage patterns** - How do AI agents typically use each tool?
6. **Dependencies and requirements** - What external systems are needed?

#### Critical Evaluation Questions:

1. **Is this tool essential for AI coding workflows?** (Critical/Important/Nice-to-have/Unnecessary)
2. **Can we safely omit this tool** without significantly impacting AI agent capabilities?
3. **Should we match Cursor's implementation exactly** or is a different approach justified?
4. **What are the technical tradeoffs** of different implementation approaches?
5. **How does this tool integrate with others** in typical AI workflows?

### 3. Gap Analysis and Prioritization

#### Compare Our Current Implementation:

Current Minsky session tools:

- ✅ `session_read_file`, `session_write_file`, `session_delete_file`
- ✅ `session_list_directory`, `session_file_exists`, `session_create_directory`

Against Cursor's complete toolset:

- ❓ `edit_file`, `search_replace`, `reapply`
- ❓ `codebase_search`, `grep_search`, `file_search`
- ❓ `run_terminal_cmd`
- ❓ `web_search`, `fetch_pull_request`, `fetch_github_issue`
- ❓ `create_diagram`, `edit_notebook`
- ❓ `fetch_rules`

#### Evaluation Criteria:

For each missing tool, determine:

1. **Criticality Score** (1-10): How essential is this for AI coding workflows?
2. **Implementation Complexity** (Low/Medium/High): Development effort required
3. **Session Relevance** (High/Medium/Low/None): Does this need session-aware version?
4. **Alternative Solutions**: Can existing tools cover this functionality?

#### Research Deliverable:

Create `docs/cursor-tool-gap-analysis.md` with:

- Prioritized list of missing tools
- Justification for inclusion/exclusion decisions
- Implementation complexity assessment
- Recommended development order

### 4. User Feedback and Clarification Protocol

When research reveals ambiguities or underspecified requirements:

#### Required User Consultation Areas:

1. **Conflicting information** about tool implementations
2. **Unclear tool priorities** when multiple approaches are valid
3. **Licensing or legal concerns** with identified source libraries
4. **Technical architecture decisions** that impact the overall system
5. **Resource allocation questions** for complex implementations

#### Consultation Format:

- Present research findings clearly
- Outline specific decision points requiring input
- Provide recommended approaches with rationale
- Include implementation tradeoffs and timeline impacts

## Problem Statement

AI coding agents using Minsky need access to the same comprehensive toolset available in Cursor, but with these critical differences:

1. All file operations must be scoped to session workspaces
2. All search operations must be limited to session workspace content
3. Terminal commands must execute within session workspace context
4. Tools must be discoverable and usable by various AI coding agents (not just Cursor)

## Implementation Approach Decision ✅

**DECISION FINALIZED**: After consultation with MCP expert, proceeding with **direct implementation approach** using open source libraries and existing tools wherever possible.

### Selected Strategy: Direct Implementation with Open Source Libraries

1. **Primary Approach**: Implement session-aware versions of critical tools directly
2. **Leverage Existing Libraries**: Use proven open source libraries (ripgrep, fzf, etc.) identified through research
3. **Incremental Delivery**: Focus on most critical tools first for immediate workflow improvement
4. **Session Workspace Enforcement**: All tools use absolute session workspace paths for proper isolation

### Rejected Approaches:

- **Tool Proxy/Recommendation Pattern**: Determined to be architecturally unreliable after expert consultation
- **Cursor Tool Delegation**: MCP protocol limitations make this approach infeasible

## Updated Requirements

### 1. Research-Driven Implementation ✅ COMPLETED

Research phase completed with comprehensive analysis of tool origins and implementation approaches.

### 2. Evidence-Based Tool Selection

Based on research findings:

- Implement only tools identified as **Critical** or **Important** for AI workflows
- Justify any deviations from Cursor's exact interface based on technical or architectural reasons
- Document rationale for omitted tools
- Prioritize based on usage frequency and workflow impact

### 3. Core File Operation Tools

Implement session-aware versions based on research findings:

- **`session_edit_file`**:

  - Match Cursor's exact interface and behavior patterns
  - Support the same `// ... existing code ...` pattern as Cursor
  - Enforce session workspace boundaries
  - Support file creation
  - Maintain compatibility with AI agent expectations

- **`session_search_replace`**:
  - Implement based on research of Cursor's approach
  - Replace single occurrence with contextual matching
  - Optimized for large files (>2500 lines as per Cursor docs)
  - Enforce session workspace boundaries

### 4. Search and Discovery Tools

Implementation approach based on identified source technologies:

- **`session_grep_search`**:

  - Use same underlying technology as Cursor (likely ripgrep)
  - Fast regex pattern matching within session
  - Support include/exclude patterns
  - Case sensitivity options
  - Results capped appropriately (50 matches as per Cursor)

- **`session_codebase_search`**:

  - Implement using same semantic search approach as Cursor
  - Semantic search within session workspace only
  - Directory filtering with glob patterns
  - Relevance scoring matching Cursor's approach

- **`session_file_search`**:
  - Use same fuzzy matching algorithm as Cursor
  - Fuzzy file path matching within session
  - Efficient implementation for large codebases
  - Results capped to 10 as per Cursor

### 5. Command Execution

- **`session_run_command`**:
  - Implement based on Cursor's approach (likely node-pty or similar)
  - Execute commands with pwd set to session workspace
  - Maintain shell context between calls
  - Support for background processes and timeouts
  - Environment isolation between sessions
  - **Note**: Security considerations will be addressed separately

### 6. External Integration Assessment

Based on research, evaluate whether these tools need session-aware versions:

- `web_search` - likely no session modifications needed
- `fetch_pull_request`, `fetch_github_issue` - may need session context for proper attribution
- `create_diagram` - no session modifications needed
- `edit_notebook` - needs session workspace enforcement

## Implementation Plan (Updated)

### Phase 0: Research and Analysis ✅ COMPLETED

1. [x] Conduct comprehensive web research on Cursor tool origins
2. [x] Analyze MCP protocol and available tool libraries
3. [x] Create tool origins analysis document
4. [x] Perform gap analysis comparing current vs needed tools
5. [x] Consult with user on unclear/ambiguous findings
6. [x] Finalize prioritized implementation roadmap

### Phase 1: Critical File Operations (IMMEDIATE START)

**Priority**: Highest - Essential for AI coding workflows

1. [ ] Implement `session_edit_file`
   - Use diff/patch approach with `// ... existing code ...` pattern recognition
   - Build on existing file operation patterns
   - Enforce session workspace boundaries
2. [ ] Implement `session_search_replace`
   - Use string replacement with context validation
   - Handle large files efficiently (>2500 lines)
   - Session-scoped path resolution
3. [ ] Create comprehensive tests for file editing tools
4. [ ] Document usage patterns and examples

### Phase 2: Essential Search Operations (NEXT)

**Priority**: High - Critical for code discovery and navigation

1. [ ] Implement `session_grep_search` using **ripgrep (rg)**
   - Install/integrate ripgrep as dependency
   - Support regex, case sensitivity, include/exclude patterns
   - Limit results to 50 matches (matching Cursor)
2. [ ] Implement `session_file_search` using **fuzzy matching algorithm**
   - Implement fzf-style fuzzy matching or use existing library
   - Efficient file path search within session
   - Limit results to 10 matches (matching Cursor)
3. [ ] Implement `session_codebase_search` - **simplified semantic search**
   - Start with keyword/phrase matching (defer complex embeddings)
   - Support directory filtering with glob patterns
   - Focus on practical search functionality first
4. [ ] Create search operation tests

### Phase 3: Command Execution (LATER)

**Priority**: Medium - Important but can be phased after core tools

1. [ ] Implement `session_run_command` using **node-pty** or similar
   - Install/integrate terminal emulation library
   - Execute commands with pwd set to session workspace
   - Maintain shell context between calls (if required)
   - Support background processes and timeouts
2. [ ] Add environment isolation between sessions
3. [ ] Create command execution tests with security boundary validation

### Phase 4: Integration and Validation (Week 6)

1. [ ] Register all new tools with MCP server
2. [ ] Validate exact interface compatibility with Cursor
3. [ ] End-to-end testing with AI agents
4. [ ] Performance benchmarking against Cursor tools
5. [ ] Security boundary validation

### Phase 5: Documentation and Refinement (Week 7)

1. [ ] Create comprehensive tool documentation
2. [ ] Document differences from Cursor approach with justification
3. [ ] Create migration guides for AI agents
4. [ ] Final optimization based on testing results

## Technical Considerations

### Research-Driven Architecture

- Architecture decisions must be based on research findings
- Prefer proven technologies identified in research over custom implementations
- Document technical rationale for any deviations from Cursor's approach
- Maintain interface compatibility while allowing implementation differences

### Security

- All file operations must validate paths against session boundaries
- Extend existing SessionPathResolver for all tools
- Prevent directory traversal attacks
- Audit logging for all operations

### Compatibility

- **Exact interface compatibility** with Cursor tools where possible
- Support various AI coding agents beyond Cursor
- Preserve expected tool behaviors based on research
- Graceful degradation for unsupported features

### Architecture

- Use consistent error handling patterns across all tools
- Leverage existing MCP infrastructure
- Design for future extensibility
- Follow established patterns from completed tools

## Verification Criteria

- [ ] Research phase completed with documented findings
- [ ] Tool selection justified based on evidence and analysis
- [ ] All implemented tools maintain interface compatibility with Cursor
- [ ] Tools enforce session workspace boundaries correctly
- [ ] Performance characteristics match or exceed Cursor tools
- [ ] Search operations return only session-scoped results
- [ ] Commands execute in correct session context
- [ ] Comprehensive test coverage for all implemented tools
- [ ] Documentation includes research findings and implementation rationale
- [ ] AI agents can use tools without modification to their workflows

## Research Output Requirements

The following documents must be created during the research phase:

1. **`docs/cursor-tool-origins-analysis.md`**: Detailed analysis of each tool's likely source and implementation approach
2. **`docs/cursor-tool-gap-analysis.md`**: Comparison of current tools vs Cursor's full set with prioritization
3. **`docs/cursor-interface-compatibility.md`**: Exact interface specifications for each tool to be implemented
4. **`docs/cursor-implementation-decisions.md`**: Rationale for implementation choices and deviations from Cursor

## Success Metrics

- Research phase identifies source libraries/frameworks for 80%+ of Cursor tools
- Feature parity with critical Cursor tools (identified through research)
- Zero security boundary violations in testing
- Performance within 20% of Cursor tools where measurable
- 95%+ test coverage for implemented tools
- Successful AI agent workflows without tool-specific modifications

## Current Status: ✅ READY TO START IMPLEMENTATION

### Research Phase: COMPLETED

- ✅ Comprehensive tool origins analysis completed
- ✅ Gap analysis and prioritization completed
- ✅ MCP expert consultation completed
- ✅ Implementation approach finalized: **Direct implementation with open source libraries**

### Next Immediate Steps:

1. **Start Phase 1**: Implement `session_edit_file` and `session_search_replace`
2. **Use proven libraries**: Leverage ripgrep, fuzzy matching algorithms, diff/patch approaches
3. **Incremental delivery**: Focus on most critical tools first for immediate workflow improvement
4. **Session enforcement**: All tools use absolute session workspace paths

### Implementation Order Confirmed:

1. **FIRST**: File operations (`session_edit_file`, `session_search_replace`)
2. **NEXT**: Search operations (`session_grep_search`, `session_file_search`, `session_codebase_search`)
3. **LATER**: Command execution (`session_run_command`)

## References

- [Cursor Built-in Tools Analysis](../../docs/cursor-built-in-tools-analysis.md) (comprehensive tool specifications)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [Session Workspace Implementation](../049-implement-session-scoped-mcp-server-for-workspace-isolation.md)
- [Tool Origins Analysis](../../docs/cursor-tool-origins-analysis.md) ✅ Created
- [Gap Analysis](../../docs/cursor-tool-gap-analysis.md) ✅ Created
