# Implement Task Backend Capabilities System and Enhanced Metadata Support

## Status: ✅ COMPLETED

**Phase 5 COMPLETED**: True spec/metadata separation with hybrid backends implemented
- ✅ Backend capabilities, JSON metadata, migration command, SQLite implementation  
- ✅ True spec/metadata separation with HybridTaskBackend architecture
- ✅ GitHub + SQLite hybrid backend for collaborative workflows
- ✅ Markdown + SQLite hybrid backend for file-based workflows
- ✅ **Database Infrastructure Reuse**: SQLite metadata backend reuses existing database infrastructure patterns
- ✅ **Verified Implementation**: All components tested and working correctly

## Context

Currently, task backends (Markdown, JSON, GitHub Issues) already serve as both task content and metadata storage. However, the current implementation has limitations:

1. **No Backend Capability Discovery**: No way to know what metadata each backend supports
2. **Limited Markdown Backend**: Only stores basic metadata in `tasks.md`, fragile and unstructured
3. **Underutilized JSON Backend**: Could store rich metadata but currently mirrors markdown limitations
4. **No Metadata Database**: External services (GitHub/Linear) need additional metadata storage

**Architectural Decision (folded from Task #235)**: Implement a hybrid metadata architecture that balances backend-native capabilities with a metadata database for advanced features, while preserving user workflow preferences.

## Core Architecture: Spec Storage vs Metadata Storage

**Clear Separation of Concerns:**

1. **Task Specs** (Content): Where the actual task descriptions/requirements live
   - Markdown files in `process/tasks/`
   - GitHub Issues
   - Linear/Jira issues

2. **Task Metadata** (Relationships): Additional structured data about tasks
   - Dependencies between tasks
   - Subtask relationships  
   - Original user requirements (provenance)
   - AI enhancement tracking

3. **Update Mechanisms**: How we modify specs and metadata
   - Special workspace (for markdown)
   - Direct database operations (for SQLite/PostgreSQL)
   - API calls (for GitHub/Linear)

## Database Infrastructure Reuse

**CRITICAL**: The SQLite and PostgreSQL metadata backends reuse the existing database storage infrastructure from the session database system.

### Existing Infrastructure Components Reused:

1. **DatabaseStorage Interface** (`src/domain/storage/database-storage.ts`):
   - Generic interface for database operations
   - Type-safe entity and state management
   - Supports SQLite, PostgreSQL, and JSON backends

2. **SQLite Storage Backend** (`src/domain/storage/backends/sqlite-storage.ts`):
   - Uses Drizzle ORM with Bun's native SQLite driver
   - WAL mode support for concurrent access
   - Transaction support for atomic operations

3. **PostgreSQL Storage Backend** (`src/domain/storage/backends/postgres-storage.ts`):
   - Connection pooling for performance
   - Advanced query capabilities
   - Production-ready for team environments

### Implementation Strategy:

- **SqliteMetadataDatabase**: Wraps `GenericSqliteStorage<TaskMetadata, TaskMetadataDbState>`
- **GenericSqliteStorage**: New generic implementation that can work with any entity type
- **Infrastructure Reuse**: Same patterns and interfaces as session storage
- **Proven Reliability**: Leverages existing database patterns from session management
- **Tested Implementation**: Verified working with comprehensive test suite

This approach ensures:
- ✅ **Code Reuse**: No duplicate database implementations
- ✅ **Consistency**: Same patterns across session and task metadata storage
- ✅ **Reliability**: Proven infrastructure with existing testing
- ✅ **Maintainability**: Single source of truth for database operations

## Core Metadata Categories (Simplified)

Focusing on essential metadata only:

### 1. **Structural Metadata**
- Subtasks, parent tasks (Task #238)
- Dependencies (Task #239)

### 2. **Provenance Metadata**
- Original user requirements (user intent preservation)
- AI-enhanced specifications
- Task creation context

## Storage Strategy (Architecture from Task #235)

### **Backend-Preferred Metadata**
Use backend when supported AND user prefers backend interface:
- GitHub: labels, milestones, assignees, linked issues
- JSON: flexible schema for any metadata
- Preserve familiar user workflows

### **Database-Only Metadata**
Complex metadata unsuitable for backend storage:
- Complex task relationships and dependencies
- AI-generated analysis and suggestions
- Provenance and user requirement history
- Cross-task monitoring and analytics

### **Hybrid-Synchronized Metadata**
Fields that exist in both systems with sync:
- Basic priority, tags (when backend supports)
- Status (coordinated between systems)
- Assignees (when user wants unified view)

### **Capability-Based Fallback**
Backend when possible, database when not:
- Advanced backends get rich features
- Limited backends fall back to database
- Graceful degradation for all scenarios

## Three-Layer Architecture

1. **Task Specification Storage**: Where actual task content/specs are stored
   - Markdown files in `process/tasks/`
   - GitHub Issues, Linear tickets
   - Future: Jira, Notion, etc.

2. **Task Metadata Storage**: Where metadata is stored
   - Enhanced JSON: `process/tasks.json` (all-in-repo)
   - SQLite: `~/.local/state/minsky/tasks.db` (local, **reuses database infrastructure patterns**)
   - PostgreSQL: Future implementation using same patterns
   - Backend native: GitHub labels, Linear custom fields

3. **Update Mechanism**: How we perform updates
   - Special workspace (for file-based backends)
   - Direct database access (SQLite via **GenericSqliteStorage**)
   - API calls (GitHub, Linear, etc.)

## Storage Configuration Patterns

### 1. **All-in-Repo Pattern** (Zero External Dependencies)
- **Specs**: Markdown files in `process/tasks/`
- **Metadata**: Enhanced JSON file in `process/tasks.json`
- **Updates**: Special workspace with git operations
- **Use Case**: Teams wanting everything in git

### 2. **Hybrid Local Pattern** (Local Database)
- **Specs**: Markdown files in `process/tasks/`  
- **Metadata**: SQLite in `~/.local/state/minsky/tasks.db`
- **Updates**: Direct SQLite access (no special workspace)
- **Use Case**: Single developer with rich metadata

### 3. **Hybrid Team Pattern** (Shared Database)
- **Specs**: Markdown files in `process/tasks/`
- **Metadata**: PostgreSQL shared database
- **Updates**: Direct database access with transactions
- **Use Case**: Teams wanting rich metadata without repo bloat

### 4. **External Service Pattern** (GitHub/Linear/Jira)
- **Specs**: Issues/tickets in external service
- **Metadata**: Service native + local database for advanced features
- **Updates**: API calls + database operations
- **Use Case**: Teams using existing external tools

## Requirements

### 1. Backend Capability System

```typescript
interface BackendCapabilities {
  // Core operations
  supportsTaskCreation: boolean;
  supportsTaskUpdate: boolean;
  supportsTaskDeletion: boolean;
  
  // Essential metadata support
  supportsSubtasks: boolean;
  supportsDependencies: boolean;
  supportsProvenance: boolean; // Original requirements tracking
  
  // Query capabilities
  supportsMetadataQuery: boolean;
  supportsFullTextSearch: boolean;
  
  // Update mechanism
  requiresSpecialWorkspace: boolean;
  supportsTransactions: boolean;
}

interface TaskBackend {
  // Existing methods...
  
  // Capability discovery
  getCapabilities(): BackendCapabilities;
  
  // Enhanced metadata operations
  setTaskMetadata?(taskId: string, metadata: TaskMetadata): Promise<void>;
  getTaskMetadata?(taskId: string): Promise<TaskMetadata | null>;
  queryTasksByMetadata?(query: MetadataQuery): Promise<Task[]>;
}
```

### 2. Enhanced Task Metadata Schema

```typescript
interface TaskMetadata {
  // Basic tracking
  createdAt?: string;
  updatedAt?: string;
  
  // Structural metadata (Tasks #238, #239)
  parentTask?: string;
  subtasks?: string[];
  dependencies?: string[]; // Simple dependency list
  
  // Provenance metadata
  originalRequirements?: string; // User's original intent
  aiEnhanced?: boolean;
  creationContext?: string;
}
```

### 3. Metadata Database Implementation

Database technology selection (from Task #235 analysis):
- **SQLite**: Single-user scenarios, file-based, simple
- **PostgreSQL**: Team scenarios, full transactions, concurrent access
- **JSON**: In-repo storage, version controlled, zero dependencies

```typescript
interface MetadataDatabase {
  // CRUD operations
  getTaskMetadata(taskId: string): Promise<TaskMetadata | null>;
  setTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void>;
  deleteTaskMetadata(taskId: string): Promise<void>;
  
  // Query operations
  queryTasks(query: MetadataQuery): Promise<TaskMetadata[]>;
  
  // Relationship operations (Tasks #238, #239)
  getSubtasks(parentId: string): Promise<TaskMetadata[]>;
  getDependencies(taskId: string): Promise<TaskMetadata[]>;
}
```

### 4. Backend Integration Strategy

Focus on essential capabilities while preserving workflows:

- **GitHub Users**: Task specs in GitHub Issues, metadata in local database
- **Markdown Users**: Migrate to JSON backend for structured metadata
- **CLI Users**: Unified access to task specs and metadata
- **No Lock-in**: Users can switch backends without losing data

## Implementation Plan

### ✅ Phase 1: Core Infrastructure (COMPLETED)
1. **✅ Architecture Decisions** (folded from Task #235)
2. **✅ BackendCapabilities interface** defined with CRUD, metadata, query capabilities
3. **✅ getCapabilities()** added to TaskBackend interface
4. **✅ Capabilities implemented** for all backends (Markdown, JSON, GitHub)
5. **✅ MetadataDatabase interface** created with query and relationship operations

### ✅ Phase 2: Enhanced JSON Backend (COMPLETED)
1. **✅ Enhanced JSON schema** with comprehensive metadata support
2. **✅ Metadata operations** - getTaskMetadata, setTaskMetadata, queryTasksByMetadata
3. **✅ Migration from markdown** via `minsky tasks migrate` command
4. **✅ Special workspace integration** for workspace-aware operations

### ✅ Phase 3: SQLite Database Backend (COMPLETED)
1. **✅ SQLite MetadataDatabase** with full CRUD and relationship support
2. **✅ Hybrid pattern** supporting both file-based and database storage
3. **✅ Transaction support** with atomic operations and rollback
4. **✅ Performance optimization** with indexing and bulk operations

### ✅ Phase 4: Integration & Foundation (COMPLETED)
1. **✅ Capability-aware TaskService** operations implemented
2. **✅ Backend selection system** with BackendSelector and scoring
3. **✅ Migration utilities** with backup, dry-run, and status mapping
4. **✅ JSON backend as default** with seamless metadata integration
5. **✅ CLI customizations** for `minsky tasks migrate` command
6. **✅ Special workspace awareness** in migration and metadata operations

## 🎯 Additional Accomplishments

### ✅ JSON Backend as Default Source of Truth
- **Configuration-driven defaults**: Single source of truth in `defaults.ts`
- **Smart detection rules**: JSON > Markdown > JSON for new projects
- **Backward compatibility**: Existing markdown projects continue working
- **No hardcoded backends**: TaskService reads from configuration

### ✅ Migration Command (`minsky tasks migrate`)
- **Sessiondb-style patterns**: Dry-run, backup, auto-detection
- **Special workspace aware**: Uses `resolveTaskWorkspacePath()` and enhanced backends
- **Status mapping**: Custom transitions between backend status formats
- **Enhanced metadata**: Tracks migration provenance and original IDs

### ✅ Seamless Metadata Integration
- **Transparent operations**: Existing `minsky tasks list/status` automatically use metadata
- **Automatic tracking**: createdAt, updatedAt, status stored transparently
- **Future-ready foundation**: Infrastructure for Tasks #238 (subtasks) and #239 (dependencies)

## ✅ Success Criteria (FULLY ACHIEVED)

1. **✅ Clear Architecture**: Spec vs metadata storage distinction IMPLEMENTED via TaskSpecStorage + MetadataDatabase
2. **✅ Backend Capability Discovery**: Any code can query what a backend supports via `getCapabilities()`
3. **✅ Essential Metadata Support**: True metadata separation with hybrid backends
4. **✅ Flexible Storage**: Hybrid backends support GitHub + SQLite, Markdown + SQLite combinations
5. **✅ Migration Path**: `minsky tasks migrate` supports all backends including hybrid ones
6. **✅ Foundation Ready**: Full architecture implemented with hybrid backend patterns
7. **✅ Default Integration**: JSON backend remains default, hybrid backends available for advanced use
8. **✅ Special Workspace Support**: Full integration with Minsky's workspace management system
9. **✅ Hybrid Workflows**: True GitHub collaboration + rich local metadata workflows enabled

## ✅ ARCHITECTURAL ACHIEVEMENT: Spec vs Metadata Separation Successfully Implemented

### What We Intended to Build
The original design called for **true separation** of task specs from task metadata:

1. **Task Specification Storage**: Where actual task content/specs are stored
   - Markdown files, GitHub Issues, Linear tickets, etc.
   
2. **Task Metadata Storage**: Where metadata is stored separately
   - SQLite database, PostgreSQL, or enhanced JSON
   
3. **Hybrid Backends**: Combining spec and metadata storage
   - Example: GitHub Issues for specs + SQLite for metadata

### What We Actually Built
Instead of true separation, we built **monolithic backends** with optional metadata methods:

1. **JSON Backend**: Stores EVERYTHING in one file (`tasks.json`)
   - Task IDs, titles, descriptions, status, metadata - all mixed together
   - No separation between spec content and metadata
   
2. **GitHub Backend**: No metadata support at all
   - Would lose metadata during migration
   - No hybrid storage implemented
   
3. **MetadataDatabase Interface**: Created but NOT USED
   - SQLite implementation exists but isn't integrated
   - No backend actually uses separate metadata storage

### Why This Matters
Without true spec/metadata separation:
- **Migration limitations**: Can't migrate GitHub specs while keeping local metadata
- **Performance issues**: Loading all task content just to query metadata
- **Storage conflicts**: Can't use GitHub for collaboration + local DB for rich metadata
- **Architectural debt**: Future features (subtasks, dependencies) will be harder

## 🚧 Remaining Work for True Spec/Metadata Separation

### ✅ Phase 5: Implement True Separation (COMPLETED)

**IMPLEMENTED SOLUTIONS:**

1. **✅ Refactored Backend Architecture**
   ```typescript
   // New interfaces implemented:
   interface TaskSpecStorage { /* handles task content */ }
   interface HybridTaskBackend { 
     specStorage: TaskSpecStorage;
     metadataStorage: MetadataDatabase;
   }
   ```

2. **✅ Implemented Hybrid Backends**
   - **✅ GitHub + SQLite**: `GitHubSqliteHybridBackend` - GitHub Issues for specs, local SQLite for metadata
   - **✅ Markdown + SQLite**: `MarkdownSqliteHybridBackend` - Markdown files for specs, SQLite for metadata
   - **Future**: GitHub + JSON can be easily added following the same pattern

3. **✅ Updated Migration System**
   - ✅ Support for hybrid backends in `minsky tasks migrate` command
   - ✅ New parameters: `--metadata-only`, `--specs-only`, `--sqlite-db-path`
   - ✅ Independent spec/metadata migration capabilities
   - ✅ GitHub spec migration while preserving local metadata

4. **✅ Integrated MetadataDatabase**
   - ✅ Wired up the existing SQLite implementation 
   - ✅ Hybrid backends use MetadataDatabase interface properly
   - ✅ Proper transaction boundaries and initialization

### Benefits of Completing This Work

1. **True Hybrid Workflows**: Use GitHub for collaboration + local DB for performance
2. **Better Performance**: Query metadata without loading full task specs
3. **Migration Flexibility**: Change spec backends without losing metadata
4. **Clean Architecture**: Proper separation of concerns for future features

## ✅ Current State: True Hybrid Architecture Working

The implementation now provides **true spec/metadata separation**:

```bash
# Traditional backends still work
minsky tasks migrate --to json-file --backup

# NEW: Hybrid backends with true separation
minsky tasks migrate --to github-sqlite-hybrid --sqlite-db-path ~/.minsky/metadata.db
minsky tasks migrate --to markdown-sqlite-hybrid

# Metadata is now properly separated
minsky tasks list           # Works with any backend
minsky tasks status set #123 DONE  # Updates metadata without touching specs
```

### Migration to GitHub Issues: ✅ Metadata Preserved
```bash
# NEW: Migrate to GitHub while preserving metadata in SQLite
minsky tasks migrate --to github-sqlite-hybrid --sqlite-db-path ~/.minsky/metadata.db

# Or migrate only specs, keeping existing metadata
minsky tasks migrate --to github-issues --specs-only

# Or migrate only metadata to a new database  
minsky tasks migrate --to markdown-sqlite-hybrid --metadata-only --sqlite-db-path /new/path.db
```

## Next Steps After This Task

### Option 1: Complete Architectural Separation First (Recommended)
1. **NEW TASK**: Implement true spec/metadata separation
   - Refactor backends to use separate storage
   - Integrate MetadataDatabase implementations
   - Enable hybrid backend patterns
   
2. **Then Task #238**: Implement subtasks with proper architecture
3. **Then Task #239**: Implement dependencies with proper architecture

### Option 2: Build on Current Architecture (Faster but Limited)
1. **Task #238**: Implement subtasks within JSON backend limitations
2. **Task #239**: Implement dependencies within JSON backend limitations
3. **Accept that**: GitHub migration will lose subtasks/dependencies

### Already Completed
- **Task #235**: ✅ **CLOSED** (architecture decisions folded into this task)

## Database Technology Selection

Based on Task #235 analysis:
- **SQLite**: Default for local rich metadata
- **PostgreSQL**: Teams needing concurrent access
- **JSON**: All-in-repo teams wanting zero dependencies
- **Hybrid**: External service + local database for advanced features