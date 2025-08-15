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

**Primary Goal**: Rename and extend `task_embeddings` → `task_metadata` while preserving embeddings:

1. **Structural Metadata** (from Task #315):
   - Task dependencies (`prerequisite`, `optional`, `related`)
   - Parent-child relationships (subtasks)
   - Cross-task references and relationships

2. **Provenance Metadata** (from Task #315):
   - Original user requirements preservation
   - AI-enhanced specification tracking
   - Task creation context and history

3. **Backend Integration Metadata**:
   - Task backend routing information
   - Cross-backend task relationships
   - External system synchronization data

4. **Enhanced Search Metadata**:
   - Content hashing for staleness detection
   - Last embedding update tracking
   - Search optimization metadata

### 📋 FUTURE: Advanced Analysis Features

The following advanced features can be built **after** the metadata extension is complete:

- **Duplicate Detection**: `minsky tasks find-duplicates` using similarity thresholds
- **Dependency Discovery**: `minsky tasks suggest-dependencies` using content analysis
- **Task Clustering**: `minsky tasks cluster` for project organization
- **Relationship Analysis**: `minsky tasks analyze-relationships` for project health

## Technical Implementation

### ✅ CURRENT: Embedding Infrastructure (Working)

**Embedding Generation** - Using OpenAI embeddings via AI completion infrastructure:
- ✅ Extract content from task titles, descriptions, and specifications
- ✅ OpenAI `text-embedding-3-small` with 1536 dimensions
- ✅ Batch processing and error handling
- ✅ Content hashing for staleness detection

**PostgreSQL + pgvector Storage** - Using session database connection:
- ✅ `task_embeddings` table with `vector(1536)` column
- ✅ IVFFlat indexing for fast approximate nearest neighbor search
- ✅ SQL KNN queries: `ORDER BY embedding <-> $1::vector LIMIT k`
- ✅ Session database reuse via `vectorStorage.useSessionDb = true`

**Vector Storage Abstraction**:
- ✅ `PostgresVectorStorage`: Production pgvector storage
- ✅ `MemoryVectorStorage`: Development/testing storage
- ✅ `VectorStorage` interface for future backends

### 🚧 PLANNED: Metadata Extension Architecture

**Schema Evolution Strategy** - Extend `task_embeddings` → `task_metadata`:

```sql
-- Phase 1: Add new columns (preserving existing data)
ALTER TABLE task_embeddings
ADD COLUMN task_metadata JSONB DEFAULT '{}',
ADD COLUMN qualified_task_id TEXT,
ADD COLUMN content_hash TEXT,
ADD COLUMN last_indexed_at TIMESTAMPTZ;

-- Phase 2: Populate qualified task IDs
UPDATE task_embeddings
SET qualified_task_id = CASE
  WHEN task_id ~ '^[a-z]+#[0-9]+$' THEN task_id  -- Already qualified
  WHEN task_id ~ '^[0-9]+$' THEN 'md#' || task_id -- Legacy format
  ELSE task_id
END;

-- Phase 3: Rename table (optional, can keep existing name)
-- ALTER TABLE task_embeddings RENAME TO task_metadata;

-- Phase 4: Add constraints and indexes
ALTER TABLE task_embeddings
ADD CONSTRAINT unique_qualified_task_id UNIQUE (qualified_task_id);

CREATE INDEX idx_task_embeddings_metadata ON task_embeddings USING gin (task_metadata);
```

**Extended Metadata Schema**:

```typescript
interface TaskMetadata {
  // Existing embedding metadata (preserved)
  embedding?: {
    model: string;
    dimension: number;
    contentHash: string;
    lastIndexed: string;
  };

  // NEW: Structural metadata (Task #315)
  structure?: {
    parentTask?: string;
    subtasks?: string[];
    dependencies?: {
      prerequisite?: string[];
      optional?: string[];
      related?: string[];
    };
  };

  // NEW: Provenance metadata (Task #315)
  provenance?: {
    originalRequirements?: string;
    aiEnhanced?: boolean;
    creationContext?: string;
    lastModified?: string;
  };

  // NEW: Backend integration metadata
  backend?: {
    sourceBackend: string;
    externalId?: string;
    lastSync?: string;
    syncMetadata?: Record<string, any>;
  };
}
```

### Migration Strategy for Legacy Task IDs

**Problem**: Existing embeddings may use unqualified task IDs ("123" vs "md#123")

**Solution**: Safe, non-destructive migration:

1. **Detection**: Query existing `task_id` values to identify formats
2. **Qualification**: Convert unqualified IDs using current backend detection rules
3. **Verification**: Cross-reference with actual task existence
4. **Update**: Populate `qualified_task_id` field with normalized values
5. **Cleanup**: Eventually deprecate `task_id` in favor of `qualified_task_id`

## Implementation Plan

### Phase 1: Database Schema Extension ⚡ (Non-Breaking)

**Goal**: Add metadata columns without disrupting existing functionality

```bash
# Create migration for schema extension
minsky sessiondb migrate --dry-run  # Preview changes
minsky sessiondb migrate --execute  # Apply migration
```

**Migration Tasks**:
1. ✅ Add new columns (`task_metadata`, `qualified_task_id`, `content_hash`, `last_indexed_at`)
2. ✅ Preserve all existing embedding data and functionality
3. ✅ Create GIN index on JSONB metadata for efficient queries
4. ✅ Add unique constraint on qualified task IDs

### Phase 2: Legacy Task ID Migration 🔄

**Goal**: Normalize task IDs without losing embeddings

```bash
# New command to handle ID migration
minsky tasks migrate-embeddings --dry-run  # Preview changes
minsky tasks migrate-embeddings --execute  # Apply migration
```

**Migration Process**:
1. **Analyze**: Query all existing `task_id` values and categorize formats
2. **Detect Backend**: Use current task backend detection rules
3. **Qualify IDs**: Convert "123" → "md#123" based on detected backend
4. **Verify Tasks**: Cross-check qualified IDs against actual task existence
5. **Update Records**: Populate `qualified_task_id` field for all existing embeddings
6. **Report Results**: Show migration summary and any conflicts

### Phase 3: Metadata Service Integration 🔌

**Goal**: Integrate with existing TaskService for metadata operations

**New Services**:
```typescript
interface TaskMetadataService {
  // Core metadata operations
  getTaskMetadata(taskId: string): Promise<TaskMetadata | null>;
  setTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void>;
  updateTaskMetadata(taskId: string, updates: Partial<TaskMetadata>): Promise<void>;

  // Relationship operations (Task #315 architecture)
  getTaskDependencies(taskId: string): Promise<string[]>;
  setTaskDependencies(taskId: string, deps: string[]): Promise<void>;
  getSubtasks(parentId: string): Promise<string[]>;

  // Search and query operations
  queryTasksByMetadata(query: MetadataQuery): Promise<string[]>;
  findTasksByStructure(structure: Partial<TaskStructure>): Promise<string[]>;
}
```

**TaskService Integration**:
- Extend existing TaskService to use TaskMetadataService
- Support hybrid workflows (GitHub Issues + local metadata)
- Maintain backward compatibility with existing backends

### Phase 4: Hybrid Backend Implementation 🔀

**Goal**: Enable the GitHub Issues + local metadata workflow from Task #315

**Hybrid Patterns**:
1. **GitHub + Metadata**: GitHub Issues for specs, PostgreSQL for metadata
2. **Markdown + Metadata**: Markdown files for specs, PostgreSQL for metadata
3. **JSON + Metadata**: Enhanced JSON backend with embedded metadata support

**Configuration**:
```toml
[taskMetadata]
backend = "postgres"        # or "sqlite"
useSessionDb = true         # Reuse session database connection
enableHybridMode = true     # Support spec/metadata separation

[vectorStorage]
backend = "postgres"
useSessionDb = true         # Same database as metadata

[embeddings]
provider = "openai"
model = "text-embedding-3-small"
```

## Benefits of This Approach

### 🎯 Strategic Advantages

1. **Preserves Investment**: All existing embeddings and similarity functionality remain intact
2. **Progressive Enhancement**: Non-breaking changes that extend functionality gradually
3. **Infrastructure Reuse**: Leverages proven session database architecture
4. **Task #315 Completion**: Achieves the spec/metadata separation architecture goal

### 🚀 Technical Benefits

1. **Single Database**: Embeddings and metadata in one place reduces complexity
2. **JSONB Flexibility**: Rich metadata without rigid schema constraints
3. **PostgreSQL Power**: Advanced querying, indexing, and relationship capabilities
4. **Hybrid Workflows**: Support for any task backend + rich local metadata

### 🔄 Migration Safety

1. **Zero Downtime**: All changes are additive, existing features work throughout
2. **Rollback Capability**: Can revert changes without losing existing data
3. **Gradual Adoption**: Users can migrate to metadata features incrementally
4. **Legacy Support**: Existing embeddings continue working with legacy task IDs

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

### ✅ PHASE 1: Similarity Search (COMPLETED)

- [x] **Embedding Generation**: OpenAI embedding service with `text-embedding-3-small`
- [x] **Vector Storage**: PostgreSQL + pgvector using session database connection
- [x] **Similarity Search**: `minsky tasks similar <task-id>` returns ranked similar tasks
- [x] **Natural Language Search**: `minsky tasks search <query>` supports semantic queries
- [x] **Batch Indexing**: `minsky tasks index-embeddings` generates embeddings efficiently
- [x] **Backend Integration**: Works with JSON, Markdown, and GitHub Issues backends

### 🚧 PHASE 2: Metadata Extension (CURRENT GOAL)

#### Database Schema Extension
- [ ] **Non-Breaking Migration**: Add metadata columns without disrupting existing embeddings
- [ ] **JSONB Metadata Field**: Support rich metadata storage with GIN indexing
- [ ] **Qualified Task IDs**: Add `qualified_task_id` column with unique constraints
- [ ] **Content Tracking**: Add `content_hash` and `last_indexed_at` for staleness detection

#### Legacy Task ID Migration
- [ ] **ID Analysis**: Analyze existing `task_id` formats (qualified vs unqualified)
- [ ] **Safe Migration**: Convert legacy "123" → "md#123" without data loss
- [ ] **Verification**: Cross-check qualified IDs against actual task existence
- [ ] **Migration Command**: `minsky tasks migrate-embeddings` with dry-run support

#### Metadata Service Integration
- [ ] **TaskMetadataService**: Core service for metadata operations
- [ ] **Relationship Support**: Dependencies, subtasks, and cross-task references
- [ ] **Provenance Tracking**: Original requirements, AI enhancements, creation context
- [ ] **Backend Integration**: Support for hybrid workflows (spec + metadata separation)

#### Configuration & CLI
- [ ] **Extended Configuration**: `taskMetadata` and enhanced `vectorStorage` config blocks
- [ ] **Hybrid Mode Support**: Enable spec/metadata separation workflows
- [ ] **Backward Compatibility**: Existing similarity commands continue working unchanged
- [ ] **Migration Tooling**: Safe, reversible migration commands with dry-run support

### 🎯 SUCCESS METRICS

1. **Preservation**: All existing similarity search functionality continues working
2. **Extension**: Support for Task #315 metadata architecture (dependencies, subtasks, provenance)
3. **Migration**: Legacy task IDs successfully migrated without embedding loss
4. **Performance**: Metadata operations perform efficiently on 500+ task database
5. **Integration**: Hybrid backends work seamlessly (GitHub Issues + local metadata)

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
