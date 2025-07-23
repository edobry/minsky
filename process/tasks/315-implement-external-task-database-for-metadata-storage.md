# Implement Task Backend Capabilities System and Enhanced Metadata Support

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
   - SQLite: `~/.local/state/minsky/tasks.db` (local)
   - PostgreSQL: Shared team database
   - Backend native: GitHub labels, Linear custom fields

3. **Update Mechanism**: How we perform updates
   - Special workspace (for file-based backends)
   - Direct database access (SQLite/PostgreSQL)
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

### Phase 1: Core Infrastructure (Week 1)
1. **✅ Architecture Decisions** (folded from Task #235)
2. Define BackendCapabilities interface
3. Add getCapabilities() to TaskBackend interface
4. Implement capabilities for existing backends
5. Create basic MetadataDatabase interface

### Phase 2: Enhanced JSON Backend (Week 2)
1. Implement enhanced JSON schema with metadata support
2. Add efficient metadata operations 
3. Create migration from markdown backend
4. Integrate with special workspace system

### Phase 3: SQLite Database Backend (Week 2-3)
1. Implement SQLite-based MetadataDatabase
2. Create hybrid spec+database pattern
3. Add transaction support and concurrent access
4. Performance optimization for queries

### Phase 4: Integration & Foundation (Week 3-4)
1. Update TaskService to use capability-aware operations
2. Create backend selection and configuration system
3. Add migration utilities between storage patterns
4. **Prepare for Task #238 (subtasks) and Task #239 (dependencies)**

## Success Criteria

1. **✅ Clear Architecture**: Spec vs metadata storage distinction established
2. **Backend Capability Discovery**: Any code can query what a backend supports
3. **Essential Metadata Support**: Structural and provenance metadata working
4. **Flexible Storage**: Users can choose pattern based on needs
5. **Migration Path**: Smooth transition from markdown backend
6. **Foundation Ready**: Tasks #238 and #239 can build on this infrastructure

## Next Steps After This Task

1. **Task #238**: Implement subtasks using the metadata infrastructure
2. **Task #239**: Implement dependencies using the relationship support
3. **Task #235**: ✅ **CLOSE** (architecture folded into this task)

## Database Technology Selection

Based on Task #235 analysis:
- **SQLite**: Default for local rich metadata
- **PostgreSQL**: Teams needing concurrent access
- **JSON**: All-in-repo teams wanting zero dependencies
- **Hybrid**: External service + local database for advanced features