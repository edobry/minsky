# Implement Context-Aware Tool Management System

## Status

BACKLOG

## Priority

**CRITICAL** (Elevated from HIGH due to immediate context pollution impact)

## Description

# Implement Context-Aware Tool Management System

## Context

As our MCP tool ecosystem grows larger and more sophisticated, we face **immediate and critical context pollution** - providing AI agents with too many irrelevant tools that consume valuable context space and lead to suboptimal tool selection.

**CRITICAL DISCOVERY**: Analysis of the `minsky context generate` command reveals that tool schemas consume **73% of total context** (15,946 out of 21,853 tokens), with **no intelligent filtering** applied regardless of user query or task context.

**Current Context Pollution Evidence:**

```bash
🔍 Context Analysis (minsky context generate --analyze-only)
Total Tokens: 21,853
tool-schemas: 15,946 tokens (73.0% of total context!)
Context Window Utilization: 17.1%

💡 System flags tool-schemas as top optimization opportunity
Potential savings: 6,378+ tokens (30%+ context reduction)
```

**The Problem:** Even when users specify targeted queries like:

- `minsky context generate --prompt "help me debug a failing test"`
- `minsky context generate --prompt "review this pull request"`

The system **includes ALL 50+ tools** from ALL categories instead of filtering for relevant tools.

We need intelligent **differential tool availability** that:

1. **Eliminates Context Pollution** - Reduces tool schemas from 15,946 to ~5,000 tokens (68% reduction)
2. **Improves AI Decision-making** - Provides only relevant tools, reducing choice overload
3. **Adapts to User Queries** - Filters tools based on user prompt and task context
4. **Scales with Tool Growth** - Manages increasing tool complexity intelligently
5. **Optimizes Context Usage** - Frees 10,000+ tokens for more relevant information

This system will serve as the foundation for intelligent context management and enhanced AI agent productivity.

## Dependencies

**COMPLETED INFRASTRUCTURE** (Previously listed as "may leverage" - now proven and operational):

1. **✅ Task #253 (IN-REVIEW)**: Task similarity search using PostgreSQL + pgvector - **IMPLEMENTED**
2. **✅ Task #445 (DONE)**: Embedding-based rule suggestion with `rules_embeddings` table - **OPERATIONAL**
3. **✅ Task #449 (IN-PROGRESS)**: Extended embeddings with server-side filtering - **AVAILABLE**
4. **🚧 Task #447 (TODO)**: Generic similarity search service with pluggable backends - **FOUNDATION**

**CURRENT INFRASTRUCTURE**:

- ✅ PostgreSQL + pgvector database storage
- ✅ OpenAI embedding service integration
- ✅ `task_embeddings` and `rules_embeddings` tables
- ✅ Similarity search with configurable thresholds
- ✅ Session database connection reuse

**INTEGRATION POINTS**:

1. **MCP Tool System**: Integrates with existing MCP server and tool infrastructure
2. **Session Management**: Leverages session context and current session detection
3. **Task Management**: Integrates with task system for task-specific tool selection
4. **Context Generation**: **PRIMARY INTEGRATION** - Optimizes `tool-schemas` component

## Objective

Implement a comprehensive context-aware tool management system that intelligently selects and provides only the most relevant tools to AI agents based on current task context, workflow phase, session characteristics, and **user queries in context generation**.

**IMMEDIATE TARGET**: Reduce context pollution in `minsky context generate` by implementing query-aware tool filtering.

## Core Features

### 1. **PRIORITY: Context Generation Integration**

**Query-Based Tool Filtering for `minsky context generate`:**

- **Semantic Analysis**: Parse user `--prompt` parameter to understand intent
- **Tool Category Mapping**: Map user queries to relevant tool categories
- **Dynamic Filtering**: Include only tools relevant to user query and task context
- **Token Optimization**: Target 60-70% reduction in tool-schemas token usage

**Implementation Examples:**

```bash
# Query: "help me debug a failing test"
# Include: tasks, git bisect, test runners, debugging utilities
# Exclude: session creation, config management, AI models, deployment

# Query: "review this pull request"
# Include: git commands, diff analysis, code review tools
# Exclude: test tools, session management, database operations

# Query: "implement user authentication"
# Include: task management, file operations, security-related tools
# Exclude: git bisect, database migration, deployment scripts
```

### 2. Context-Aware Tool Selection

**Dynamic Tool Filtering:**

- Automatically filter available tools based on current context
- Support for multiple context dimensions (task, workflow, session, user query)
- Configurable tool selection rules and policies
- Real-time tool availability updates as context changes

**Context Detection:**

- Automatic workflow phase detection (planning, implementation, debugging, testing, review)
- Task type classification (feature, bugfix, refactor, maintenance)
- Session characteristics analysis (new vs. ongoing, complexity, domain)
- User query semantic analysis for intent detection

### 3. Workflow Phase Management

**Phase-Specific Tool Sets:**

- **Planning Phase**: Task management, analysis, and planning tools
- **Implementation Phase**: Code editing, file management, and development tools
- **Debugging Phase**: Debugging tools (git bisect, log analysis, test runners)
- **Testing Phase**: Test execution, coverage, and validation tools
- **Review Phase**: Code review, diff analysis, and quality assurance tools

**Phase Detection:**

- Automatic detection based on recent actions and context
- Manual phase override capabilities
- Phase transition triggers and notifications
- Historical phase analysis for pattern recognition

### 4. Task-Specific Tool Management

**Task Type Classification:**

- Analyze task content and automatically classify type
- Map task types to relevant tool categories
- Support for custom task type definitions
- Integration with task hierarchy and dependency systems

**Domain-Specific Tools:**

- Frontend development tools for UI/UX tasks
- Backend development tools for API and service tasks
- Database tools for data-related tasks
- DevOps tools for infrastructure and deployment tasks

### 5. **Tool Description Embeddings** (Proven Infrastructure)

**Leveraging Existing Embedding Infrastructure:**

- Generate embeddings for tool descriptions and capabilities using proven pgvector + OpenAI patterns
- Semantic search for relevant tools based on current context using generic similarity service (mt#447)
- Tool recommendation based on similarity to current work
- Integration with existing embedding infrastructure from tasks/rules domains

**Proven Implementation Patterns:**

- Reuse `OpenAIEmbeddingService` and `PostgresVectorStorage` from mt#253
- Follow `rules_embeddings` table structure from mt#445
- Leverage server-side filtering patterns from mt#449
- Build on generic similarity service foundation from mt#447

## Technical Implementation

### Core Architecture

1. **ToolSimilarityService:**

   - **Built on Generic Similarity Service (mt#447)** with pluggable backends
   - Semantic tool matching using embeddings + vector search
   - Fallback to keyword search when embeddings unavailable
   - Configurable similarity thresholds and result limits

2. **ContextAwareToolFilter:**

   - **Primary Integration Point**: Modifies `tool-schemas` component in context generation
   - Multi-dimensional context analysis (user query, task, session, workflow)
   - Rule-based and embedding-based filtering
   - Integration with existing context management systems

3. **Tool Metadata Registry:**
   - Comprehensive tool descriptions with context tags
   - Tool capability and use case documentation
   - Tool relationship and dependency mapping
   - Usage statistics and effectiveness metrics

### Database Schema (Following Proven Patterns)

**`tool_embeddings` table (modeled after `task_embeddings` and `rules_embeddings`):**

```sql
CREATE TABLE tool_embeddings (
  id TEXT PRIMARY KEY,                    -- UUID or generated ID
  tool_id TEXT,                          -- Tool command ID (e.g., "tasks.list")
  category TEXT,                         -- Tool category (e.g., "TASKS", "GIT")
  dimension INT NOT NULL,                -- Embedding dimension (1536 for OpenAI)
  embedding vector(dimension),           -- pgvector embedding
  metadata JSONB,                        -- Tool metadata (description, tags, etc.)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for similarity search
CREATE INDEX idx_tool_embeddings_hnsw ON tool_embeddings
  USING hnsw (embedding vector_cosine_ops);
```

### Context Generation Integration

**Modified `tool-schemas` Component:**

```typescript
// src/domain/context/components/tool-schemas.ts
export const ToolSchemasComponent: ContextComponent = {
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // NEW: Query-aware tool filtering
    if (context.userQuery || context.userPrompt) {
      const relevantTools = await toolSimilarityService.findRelevantTools({
        query: context.userQuery || context.userPrompt,
        taskContext: context.task,
        sessionContext: context.session,
        limit: 20, // Reduced from 50+ tools
        threshold: 0.3,
      });

      return {
        toolSchemas: relevantTools,
        totalTools: relevantTools.length,
        filteredBy: "user-query",
        // ... existing fields
      };
    }

    // Fallback to existing logic for backward compatibility
    return generateAllTools(context);
  },
  // ... rest of component
};
```

### Tool Selection Algorithm

1. **Base Tool Set:**

   - Always-available core tools (file operations, basic search)
   - Context-independent utility tools
   - Safety and emergency tools

2. **Query-Driven Selection:**

   - Parse user query for intent and domain keywords
   - Semantic similarity matching using embeddings
   - Category-based filtering based on detected intent
   - Prioritize tools by relevance score

3. **Context-Specific Addition:**

   - Add tools based on detected context (task, session, workflow)
   - Respect context size limits and constraints
   - Dynamic tool swapping as context changes

4. **Adaptive Learning:**
   - Learn from tool usage patterns
   - Adjust tool selection based on effectiveness
   - Improve context detection accuracy over time

## Implementation Phases

### Phase 1: Context Generation Integration (IMMEDIATE)

**Week 1-2: Foundation**

1. **Tool Embeddings Infrastructure:**

   - Create `tool_embeddings` table using proven schema patterns
   - Implement `ToolEmbeddingService` reusing OpenAI + pgvector infrastructure
   - Generate embeddings for all existing tools using mt#445 patterns

2. **Generic Similarity Service Integration:**
   - Implement `ToolSimilarityService` extending generic similarity service (mt#447)
   - Add tool-specific adapters for content extraction and ID mapping
   - Configure fallback chain: embeddings → keyword → category-based

**Week 3-4: Context Integration** 3. **Query-Aware Tool Filtering:**

- Modify `tool-schemas` component to accept user query
- Implement semantic tool matching for user prompts
- Add configuration for tool count limits and similarity thresholds

4. **Testing and Validation:**
   - Test context generation with various user queries
   - Validate token reduction and relevance improvements
   - Benchmark performance and accuracy

### Phase 2: Advanced Context Awareness (FOLLOW-UP)

**Month 2: Enhanced Intelligence**

1. **Workflow Phase Detection:**

   - Implement automatic phase detection algorithms
   - Create phase-specific tool mappings
   - Add manual override capabilities

2. **Session and Task Integration:**
   - Integrate with session context for tool recommendations
   - Add task-type-based tool filtering
   - Implement tool usage analytics

### Phase 3: Dynamic Tool Management (FUTURE)

**Month 3: MCP Integration**

1. **Real-time Tool Registration:**

   - Implement dynamic tool registration/deregistration
   - Create tool selection middleware for MCP server
   - Add real-time tool availability updates

2. **Performance Optimization:**
   - Implement caching strategies for tool metadata
   - Add tool usage monitoring and analytics
   - Optimize similarity search performance

## Use Cases

### 1. **PRIMARY: Context Generation Optimization**

```bash
# Before: 21,853 tokens (15,946 from tool-schemas)
minsky context generate --prompt "help me debug a failing test"

# After: ~11,000 tokens (5,000 from filtered tool-schemas)
# Includes: tasks, git, test tools, debugging utilities
# Excludes: session management, config, AI models, deployment
# Result: 50% context reduction, 10,000+ tokens freed for relevant content
```

### 2. Debugging Workflow

```bash
# Context: Debugging complex test failure
# Phase: Debugging
# User Query: "investigate test failures and performance issues"

# System automatically provides:
- git_bisect_tool, git_blame, git_log
- test_runner_tool, test_coverage
- log_analysis_tool
- stack_trace_analyzer
- performance_profiler

# System excludes:
- project_planning_tools
- documentation_generators
- deployment_tools
- session_creation_tools
```

### 3. Planning and Design Phase

```bash
# Context: Planning new feature architecture
# User Query: "plan and design authentication system"
# Phase: Planning

# System automatically provides:
- task_decomposition_tool
- architecture_analysis_tool
- requirements_gathering_tool
- documentation_tools
- dependency_analyzer

# System excludes:
- git_bisect_tool
- performance_debugging_tools
- deployment_scripts
- test_execution_tools
```

### 4. Implementation Phase

```bash
# Context: Implementing authenticated API endpoints
# User Query: "implement user login and session management"
# Task Domain: Backend

# System automatically provides:
- code_editor_tools
- api_testing_tools
- database_interaction_tools
- authentication_utilities
- session_management_tools

# System excludes:
- git_bisect_tool
- frontend_styling_tools
- deployment_scripts
- test_debugging_tools
```

## Integration with Existing Systems

### 1. **PRIMARY: Context Generation System**

- **Tool-Schemas Component Integration**: Modify existing component to support query-aware filtering
- **Token Optimization**: Reduce tool schemas from 15,946 to ~5,000 tokens
- **Backward Compatibility**: Maintain existing behavior when no user query provided
- **Configuration**: Add options for tool count limits and similarity thresholds

### 2. MCP Server Integration

- Dynamic tool registration and deregistration
- Real-time tool availability updates
- Tool metadata and capability exposure
- Session-specific tool management

### 3. Session Management

- Session context analysis for tool selection
- Session-specific tool preferences and history
- Tool usage tracking across sessions
- Session state integration with tool availability

### 4. Task Management

- Task-specific tool recommendations
- Task type classification for tool selection
- Integration with task hierarchy and dependencies
- Task completion workflow tool optimization

## Acceptance Criteria

### Core Functionality

- [ ] **Context Generation Integration**: Reduce tool-schemas token usage by 60-70% when user query provided
- [ ] **Tool Embeddings Infrastructure**: Generate and store embeddings for all tools using proven patterns
- [ ] **Query-Aware Filtering**: Filter tools based on semantic similarity to user prompt
- [ ] **Generic Similarity Service**: Integrate with mt#447 foundation for consistent behavior
- [ ] **Backward Compatibility**: Maintain existing behavior when no filtering requested

### Context-Aware Selection

- [ ] **User Query Analysis**: Parse and understand intent from context generation prompts
- [ ] **Semantic Tool Matching**: Use embeddings to match tools to user queries
- [ ] **Category-Based Filtering**: Intelligent tool inclusion based on detected workflow phase
- [ ] **Configurable Thresholds**: Support for similarity thresholds and tool count limits
- [ ] **Performance Optimization**: Sub-second tool selection with minimal impact

### Integration and Usability

- [ ] **Seamless Integration**: Works with existing `minsky context generate` command
- [ ] **Clear Configuration**: Easy setup and customization of tool selection rules
- [ ] **Comprehensive Testing**: Validated with various user queries and contexts
- [ ] **Monitoring and Analytics**: Track tool selection effectiveness and usage patterns
- [ ] **Documentation**: Clear usage examples and integration guides

## Success Metrics

1. **Context Efficiency**: Achieve 60-70% reduction in tool-schemas token usage
2. **Token Optimization**: Free 10,000+ tokens for more relevant context information
3. **User Experience**: Improved relevance of tools in context generation
4. **Performance**: Maintain sub-second tool selection response times
5. **Adoption**: Successful integration with existing context generation workflows

## Implementation Priority

This task is marked as **CRITICAL PRIORITY** because:

1. **Immediate Impact**: Solves critical context pollution problem affecting all AI interactions
2. **Proven Infrastructure**: Builds on completed embedding infrastructure (mt#253, mt#445)
3. **Large Token Savings**: Frees 10,000+ tokens for more relevant information
4. **Foundation for Scale**: Essential as tool ecosystem continues to grow
5. **User Value**: Directly improves context generation quality and AI agent effectiveness

The context-aware tool management system represents a critical advancement in AI agent capabilities, enabling more intelligent, efficient, and context-appropriate tool usage across all development workflows, with immediate benefits for context generation optimization.

## Implementation Plan Summary

**IMMEDIATE PRIORITY**: Context Generation Integration

- **Week 1**: Tool embeddings infrastructure using proven patterns
- **Week 2**: Generic similarity service integration for tools
- **Week 3**: Query-aware filtering in tool-schemas component
- **Week 4**: Testing, validation, and optimization

**TARGET OUTCOME**: Reduce context pollution from 73% to <30% of total context, freeing 10,000+ tokens for relevant information in `minsky context generate`.
