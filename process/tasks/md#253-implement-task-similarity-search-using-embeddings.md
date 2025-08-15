# Implement Task Similarity Search Using Embeddings and Task Metadata Storage

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

# Extend Task Embeddings Infrastructure for General Task Metadata Storage

## Context

**✅ PHASE 1 COMPLETED ([PR #89](https://github.com/edobry/minsky/pull/89))**: Task similarity search using embeddings has been successfully implemented with PostgreSQL + pgvector, reusing the existing session database infrastructure.

**Current Implementation Includes:**
- ✅ Task similarity search: `minsky tasks similar <task-id>`
- ✅ Natural language task search: `minsky tasks search <query>`  
- ✅ Embedding indexing: `minsky tasks index-embeddings [--task <id>]`
- ✅ PostgreSQL + pgvector storage using session database connection
- ✅ OpenAI embedding service with configurable providers
- ✅ `task_embeddings` table with pgvector support

**NEXT PHASE**: Extend the existing `task_embeddings` infrastructure to support **general task metadata storage**, fulfilling the architectural vision from Task #315 (spec/metadata separation) while preserving existing embeddings data.

## Current Architecture (Post-PR #89)

### Database Schema (task_embeddings table)
```sql
CREATE TABLE task_embeddings (
  id TEXT PRIMARY KEY,              -- UUID or generated ID
  task_id TEXT,                     -- Task ID (may be legacy format: "123" vs "md#123")
  dimension INT NOT NULL,           -- Embedding dimension (e.g., 1536)
  embedding vector(dimension),      -- pgvector embedding
  metadata JSONB,                   -- Currently used for embedding metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Configuration (Current)
```toml
[vectorStorage]
backend = "postgres"              # or "memory" 
useSessionDb = true               # Default: reuse session DB connection

[embeddings]
provider = "openai"               # or "local"
model = "text-embedding-3-small"  # Default embedding model
```

### Services Implemented
- **TaskSimilarityService**: Core similarity search logic
- **PostgresVectorStorage**: pgvector-based storage using session DB
- **MemoryVectorStorage**: In-memory storage for development
- **OpenAIEmbeddingService**: OpenAI-based embedding generation
- **LocalEmbeddingService**: Local/offline embedding support

## Dependencies

1. **Task #160**: ✅ **DONE** - AI completion backend (used for embedding generation)
2. **Task #182**: ✅ **DONE** - AI service patterns (used in similarity service)
3. **Task #315**: ✅ **PARTIALLY DONE** - External task database foundation (needs completion)

## Current Limitations & Opportunities

### 🚧 Issues to Address

1. **Legacy Task ID Format**: Some embeddings use unqualified task IDs ("123" vs "md#123")
2. **Limited Metadata Support**: `metadata` field currently only stores embedding metadata
3. **No General Task Metadata**: Missing the spec/metadata separation from Task #315
4. **Single-Purpose Schema**: Table designed only for embeddings, not general metadata

### 🎯 Extension Opportunity

The existing `task_embeddings` table provides the perfect foundation for general task metadata storage:
- ✅ Already uses session database (PostgreSQL/SQLite infrastructure)
- ✅ Has JSONB metadata field that can be expanded
- ✅ Contains task_id linkage for cross-referencing
- ✅ Has proper timestamps and versioning

## Objective

**PHASE 2 GOAL**: Transform the existing `task_embeddings` table into a unified **task metadata and embeddings storage system**, achieving the spec/metadata separation architecture from Task #315 while preserving all existing embedding functionality.

**Key Outcomes:**
1. **Preserve Existing Functionality**: All current similarity search features continue working
2. **Extend Metadata Storage**: Support general task metadata (dependencies, subtasks, provenance)
3. **Handle Legacy Task IDs**: Migrate and normalize task ID formats
4. **Enable Hybrid Workflows**: Support the GitHub Issues + local metadata workflow from Task #315

## Core Features

### ✅ IMPLEMENTED: Task Similarity Search

**`minsky tasks similar <task-id>`** - **WORKING**
- ✅ Find tasks similar to a given task using embeddings
- ✅ Configurable similarity threshold and result limit
- ✅ Ranked results with cosine similarity scores
- ✅ Integrates with all task backends (JSON, Markdown, GitHub Issues)

**`minsky tasks search <query>`** - **WORKING**  
- ✅ Search for tasks similar to a natural language query
- ✅ Useful for discovering existing tasks before creating new ones
- ✅ OpenAI-powered semantic search with embedding generation

**`minsky tasks index-embeddings [--task <id>]`** - **WORKING**
- ✅ Generate and store embeddings for all tasks or specific task
- ✅ Batch processing for large task collections
- ✅ Incremental updates and re-indexing support

### 🚧 NEW: Task Metadata Storage Extension

**Goal**: Extend the `task_embeddings` table to become a general `task_metadata` table that supports:

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

3. **SQLite Vector Architecture:**

   - **sqlite-vec virtual tables**: Store vectors as native SQLite columns with type safety
   - **Multiple vector formats**: float32 (standard), int8 (quantized), bit (binary)
   - **Distance metrics**: L2 (Euclidean), L1 (Manhattan), cosine, Hamming (for binary)
   - **SIMD acceleration**: AVX/NEON optimized distance calculations
   - **Native SQL KNN**: `WHERE vector MATCH ? ORDER BY distance LIMIT k`

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

2. **SQLite Vector Storage:**

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

3. **Basic Commands:**
   - `minsky tasks similar <task-id>`
   - `minsky tasks search <query>`
   - CLI interface with similarity scores and explanations

### Phase 2: Advanced SQLite Vector Features

1. **Vector Storage Optimization:**

   - Implement vector quantization (float32 → int8, binary) for storage efficiency
   - Add batch vector insert/update operations for large task corpora
   - Optimize sqlite-vec chunk storage and indexing

2. **Advanced Search Capabilities:**

   - Metadata filtering using sqlite-vec auxiliary columns
   - Hybrid search combining vector similarity with SQLite FTS5
   - Duplicate detection using configurable similarity thresholds
   - Distance metric selection (cosine, L2, L1) based on use case
   - Background embedding generation for new tasks

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
- [ ] Store vectors in SQLite using sqlite-vec extension with native vector columns
- [ ] `minsky tasks similar <task-id>` returns ranked similar tasks with distances
- [ ] `minsky tasks search <query>` supports natural language queries
- [ ] Native SQL KNN search: `WHERE vector MATCH ? ORDER BY distance LIMIT k`

### Embedding Infrastructure

- [ ] OpenAI embedding service integrated with existing AI completion system
- [ ] In-memory vector storage with efficient similarity search
- [ ] Easily swappable providers (OpenAI models, future providers)
- [ ] Easily swappable storage backends (in-memory → SQLite → PostgreSQL)

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
