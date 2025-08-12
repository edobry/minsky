# Implement Task Similarity Search Using Embeddings

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Implement Task Similarity Search Using Embeddings (PostgreSQL Spike)

## Context

As our task management system grows and becomes more complex, we need intelligent ways to:

1. **Identify duplicate or similar tasks** - Prevent task duplication and consolidate related work
2. **Evaluate task relevance** - Determine which existing tasks are related to new work
3. **Identify task dependencies** - Discover implicit relationships between tasks
4. **Improve task discovery** - Help users find related tasks when working on similar problems
5. **Enhance AI task management** - Support the AI-powered task decomposition and analysis from Task #248

This task implements semantic similarity search for tasks using embeddings with **PostgreSQL + pgvector as an experimental spike**. This approach aligns with our cloud-native deployment future and leverages existing PostgreSQL infrastructure.

**Note**: This is an experimental implementation focused on PostgreSQL. We may later backport SQLite support for local development scenarios.

## Dependencies

1. **Task #160**: ✅ **DONE** - AI completion backend provides multi-provider foundation for embedding generation
2. **Task #182**: ✅ **DONE** - Provides proven patterns for AI-powered services and structured output

## Future Enhancements (Not Blocking)

- **Task #315**: ✅ **DONE** - External task database provides foundation for metadata storage (when needed)
- Persistent vector storage (SQLite/PostgreSQL extensions)
- Additional embedding providers beyond OpenAI

## Objective

Implement a comprehensive task similarity search system using embeddings to find semantically similar tasks, enabling intelligent task management, duplicate detection, and dependency discovery.

## Core Features

### 1. Task Similarity Search

**`minsky tasks similar <task-id>`**

- Find tasks similar to a given task
- Configurable similarity threshold
- Ranked results with similarity scores
- Support for filtering by status, date, or other metadata

**`minsky tasks search <query>`**

- Search for tasks similar to a natural language query
- Useful for discovering existing tasks before creating new ones
- Supports both text queries and task description patterns

### 2. Duplicate Detection

**`minsky tasks find-duplicates [--threshold=0.8]`**

- Identify potential duplicate tasks across the entire task database
- Configurable similarity threshold for duplicate detection
- Batch processing for large task databases
- Generate reports with suggested merge/close actions

**`minsky tasks check-duplicate <task-id>`**

- Check if a specific task has potential duplicates
- Useful during task creation workflow
- Integration with `minsky tasks create` for duplicate prevention

### 3. Dependency Discovery

**`minsky tasks find-dependencies <task-id>`**

- Discover implicit dependencies between tasks
- Identify tasks that should be completed before or after a given task
- Support for both forward and backward dependency analysis
- Integration with task hierarchy system

**`minsky tasks suggest-blockers <task-id>`**

- Suggest tasks that might be blocking the given task
- Analyze task content for implicit dependencies
- Useful for project planning and task prioritization

### 4. Task Clustering and Analysis

**`minsky tasks cluster [--by-similarity]`**

- Group related tasks into thematic clusters
- Useful for project organization and sprint planning
- Support for different clustering algorithms and parameters
- Export clusters to external project management tools

**`minsky tasks analyze-relationships`**

- Comprehensive analysis of task relationships
- Generate task relationship graphs
- Identify orphaned tasks and missing connections
- Support for project health metrics

## Technical Implementation

### Embedding-Based Similarity Analysis

Using OpenAI embeddings via existing AI completion infrastructure:

1. **Task Content Processing:**

   - Extract meaningful content from task titles, descriptions, and specifications
   - Handle structured content (markdown, code blocks, lists)
   - Content chunking for large tasks
   - Normalize text for consistent embedding generation

2. **Embedding Generation:**

   - Leverage existing `DefaultAICompletionService` for provider management
   - Start with OpenAI text-embedding-3-small for cost efficiency
   - Easily configurable for other providers (OpenAI large, future providers)
   - Batch processing for efficient API usage
   - Error handling and retry logic

3. **PostgreSQL pgvector Architecture**

   - **pgvector columns**: Store embeddings in PostgreSQL as `vector(1536)` (or configured dimension)
   - **Distance operators**: `<->` (L2), `<#>` (inner product), `<=>` (cosine)
   - **Indexes**: IVFFlat and HNSW for fast approximate nearest neighbor search
   - **Native SQL KNN**: `ORDER BY embedding <-> $1 LIMIT k`
   - **Extension**: Requires `pgvector` extension installed and enabled in the target database

### Database Validation (on connect when embeddings are enabled)

On startup/connection, when embedding infrastructure is enabled in configuration:
- Verify PostgreSQL connectivity via configured `sessiondb.postgres.connectionString`
- Validate `pgvector` extension availability/version
- Ensure embeddings table exists with correct `vector(<dimension>)`
- Validate existence and health of ANN index (IVFFlat/HNSW) when configured
- Check permissions for INSERT/UPDATE/SELECT on embeddings table
- Surface actionable errors with remediation guidance

### Task Search Service Architecture

Building on proven patterns from Task #182:

1. **Service Design:**

   ```typescript
   interface EmbeddingService {
     generateEmbedding(content: string): Promise<number[]>;
     generateEmbeddings(contents: string[]): Promise<number[][]>;
   }

   interface VectorStorage {
     store(id: string, vector: number[], metadata?: any): Promise<void>;
     search(queryVector: number[], limit?: number, threshold?: number): Promise<SearchResult[]>;
     delete(id: string): Promise<void>;
   }

   class TaskSimilarityService {
     constructor(
       private embeddingService: EmbeddingService,
       private vectorStorage: VectorStorage,
       private taskService: TaskService
     ) {}
   }
   ```

2. **Provider Abstraction:**

   - OpenAI embedding service implementation using existing AI config
   - Easy addition of other providers (Cohere, OpenSource models)
   - Fallback to keyword search when embedding service unavailable
   - Configuration-driven provider selection

3. **Storage Abstraction:**

   - In-memory storage for development and testing
   - Interface designed for easy migration to persistent storage
   - Support for incremental updates and bulk operations
   - Metadata storage for task context and timestamps

### Integration with Task Management

1. **Task Service Integration:**

   - Seamless integration with existing TaskService
   - Support for all task backends (JSON, database, GitHub Issues)
   - Consistent API across different storage backends

2. **Real-time Updates:**

   - Automatic embedding generation for new tasks
   - Incremental updates for task modifications
   - Background processing for large-scale operations

3. **CLI Integration:**
   - New similarity commands in the tasks CLI
   - Integration with existing task creation and management workflows
   - Support for both interactive and programmatic usage

## Use Cases

### 1. Duplicate Prevention During Task Creation

```bash
# Check for similar tasks before creating
minsky tasks search "implement user authentication"

# Create task with automatic duplicate check
minsky tasks create "Add login functionality" --check-duplicates

# Review potential duplicates
minsky tasks check-duplicate 123
```

### 2. Project Planning and Dependencies

```bash
# Find tasks that should be completed before a task
minsky tasks suggest-blockers 150

# Discover related tasks for sprint planning
minsky tasks similar 200 --threshold=0.6

# Analyze task relationships for project health
minsky tasks analyze-relationships --export=report.json
```

### 3. Task Maintenance and Cleanup

```bash
# Find potential duplicate tasks
minsky tasks find-duplicates --threshold=0.8

# Group related tasks for better organization
minsky tasks cluster --min-cluster-size=3

# Find orphaned or unrelated tasks
minsky tasks analyze-relationships --find-orphans
```

### 4. Enhanced Task Discovery

```bash
# Find tasks related to authentication
minsky tasks search "authentication security login"

# Discover tasks similar to current work
minsky tasks similar $(minsky session get --current-task)

# Find tasks that might be relevant to a new feature
minsky tasks similar 250 --include-closed --threshold=0.5
```

## Integration with AI Features

### 1. AI Task Decomposition (Task #248)

- Use similarity search to find existing subtasks when decomposing
- Suggest reusable patterns from similar task hierarchies
- Validate decomposition against existing task structures

### 2. AI-Powered Analysis

- Enhance task analysis with similarity-based insights
- Suggest improvements based on similar successful tasks
- Identify potential gaps by comparing with similar projects

### 3. Intelligent Task Management

- Automatic tagging and categorization based on similarity
- Smart scheduling based on task relationships
- Predictive task difficulty based on similar completed tasks

## Implementation Phases

### Phase 1: Embedding Infrastructure & Core Search

1. **Embedding Service Implementation:**

   - Extend existing AI completion system to support embeddings
   - Implement OpenAI embedding provider using existing configuration
   - Create provider abstraction for future embedding services
   - Add batch processing and error handling

2. **PostgreSQL + pgvector Storage:**

<<<<<<< HEAD:process/tasks/backup-2025-08-07T23-37-16-198Z/253-implement-task-similarity-search-using-embeddings.md
   **Direct SQLite + sqlite-vec Integration**

   - **sqlite-vec extension** (6k+ stars) - Modern, no-dependency vector search for SQLite
   - Written in pure C, runs everywhere SQLite runs (Node.js, WASM, mobile, etc.)
   - Supports float32, int8, and binary vectors with multiple distance metrics
   - Native SQL syntax for vector operations and KNN search
   - Much better than JavaScript implementations or external dependencies

   **Implementation Strategy:**

   - Use sqlite-vec directly with our existing SQLite database
   - Leverage native vector columns and KNN search via virtual tables
   - Seamless integration with existing Minsky task storage
=======
   **Primary Vector Storage**
   - Use PostgreSQL with `pgvector` for production-grade vector search
   - Store embeddings in a dedicated table with `vector(<dimension>)` column and metadata
   - Implement ANN index (IVFFlat or HNSW) and tune lists/ef parameters as needed
   - Provide SQL helpers for KNN queries: `ORDER BY embedding <-> $1 LIMIT k`
   - Add migration to create/alter table, index, and constraints
>>>>>>> origin/main:process/tasks/253-implement-task-similarity-search-using-embeddings.md

3. **Basic Commands:**
   - `minsky tasks similar <task-id>`
   - `minsky tasks search <query>`
   - CLI interface with similarity scores and explanations

### Phase 2: Enhanced Search & Optimization (PostgreSQL)

1. **Performance & Index Tuning:**

   - Choose and tune index type (IVFFlat vs HNSW) based on dataset size
   - Configure and document index parameters (lists, probes, ef_search)
   - Batch insert/update strategies and periodic `ANALYZE`

2. **Advanced Search Capabilities:**

   - Metadata filtering via SQL joins on task tables
   - Hybrid search: combine vector similarity with keyword/FTS filters
   - Duplicate detection with configurable thresholds and reports
   - Background embedding generation for new/updated tasks

### Phase 3: Advanced Analytics & Integration

1. **System Integration:**

   - Integrate with existing task creation/update workflows
   - Automatic embedding generation for new/modified tasks
   - Background processing for large-scale re-indexing

2. **Advanced Analytics:**
   - Task clustering using sqlite-vec similarity results
   - Relationship analysis and insights reporting
   - Integration with external embedding providers (Cohere, local models)

## Acceptance Criteria

### Core Functionality

- [ ] Generate embeddings for all task content using OpenAI embedding service
- [ ] Store vectors in PostgreSQL using pgvector with native `vector(<dimension>)` columns
- [ ] `minsky tasks similar <task-id>` returns ranked similar tasks with distances
- [ ] `minsky tasks search <query>` supports natural language queries
- [ ] Native SQL KNN search: `ORDER BY embedding <-> $1 LIMIT k`

### Embedding Infrastructure

- [ ] OpenAI embedding service integrated with existing AI completion system
- [ ] PostgreSQL pgvector storage with efficient similarity search
- [ ] Easily swappable providers (OpenAI models, future providers)
- [ ] Config-driven enablement with connection-time validation (extension, schema, index)

### Performance and Scalability

- [ ] Efficient embedding generation and storage for 525+ tasks
- [ ] Batch processing for embedding generation and similarity search
- [ ] Incremental updates when tasks are created or modified
- [ ] Caching strategies for frequently accessed embeddings

### Integration

- [ ] Works with all existing task backends (JSON, database, GitHub Issues)
- [ ] Seamless integration with existing TaskService API
- [ ] Consistent behavior across different storage backends
- [ ] Integration with task hierarchy system

### User Experience

- [ ] Clear, actionable similarity search results
- [ ] Configurable output formats (table, JSON, summary)
- [ ] Helpful error messages and guidance
- [ ] Integration with existing CLI patterns and conventions

## Future Enhancements

### 1. Advanced AI Features

- **Semantic Task Clustering:** Automatically group tasks by project themes
- **Intelligent Task Scheduling:** Optimize task order based on similarity and dependencies
- **Predictive Analytics:** Estimate task completion time based on similar historical tasks

### 2. External Integration

- **Project Management Tools:** Export similarity analysis to Jira, Asana, etc.
- **Code Analysis Integration:** Combine with code similarity for comprehensive project analysis
- **Team Collaboration:** Share similarity insights across team members

### 3. Advanced Similarity Metrics

- **Multi-modal Similarity:** Combine text similarity with metadata, status, and timing
- **Contextual Similarity:** Consider project context and user patterns
- **Dynamic Similarity:** Adjust similarity metrics based on task outcomes

### 4. Visualization and Reporting

- **Task Relationship Graphs:** Visual representation of AI-analyzed task similarities and dependencies
- **Similarity Dashboards:** Real-time insights into task relationships
- **Trend Analysis:** Track similarity patterns over time

### 5. Future Storage Enhancement

When persistent storage is implemented:

- **SQLite Vector Storage:** Local storage using SQLite vector extension
- **PostgreSQL pgvector:** Team environments with concurrent access
- **Hybrid Storage:** Combination of multiple vector storage backends for different use cases

## Success Metrics

1. **Duplicate Reduction:** Measure reduction in duplicate task creation
2. **Dependency Discovery:** Track successful identification of task dependencies
3. **User Adoption:** Monitor usage of similarity search features
4. **Time Savings:** Measure time saved in task discovery and planning
5. **Project Health:** Track improvements in task organization and completeness

This task similarity search system will significantly enhance the task management capabilities by providing intelligent insights into task relationships, preventing duplication, and improving overall project organization and planning efficiency.
