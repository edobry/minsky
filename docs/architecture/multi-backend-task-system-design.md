# Multi-Backend Task System Architecture Design

## Overview

This document outlines the architecture design for supporting multiple concurrent task backends in Minsky, addressing the critical requirement identified in Task #138 for managing tasks across different backend systems (markdown files, GitHub Issues, JSON files) without ID conflicts.

## Current Architecture Analysis

### Current State

```typescript
// TaskService current architecture
class TaskService {
  private readonly backends: TaskBackend[] = [];
  private readonly currentBackend: TaskBackend; // Single active backend

  constructor(options: TaskServiceOptions) {
    // All operations route through currentBackend
  }
}

// Task ID format
interface Task {
  id: string; // Simple numeric string: "123", "456"
}

// Session names
// Format: "task#123", "task123"

// File paths
// Format: "process/tasks/123-title.md"
```

### Problems with Current Architecture

1. **ID Conflicts**: Task #123 can exist in both markdown and GitHub backends
2. **Single Backend Limitation**: Only one backend active at a time
3. **No Backend Association**: Tasks don't know which backend they belong to
4. **Migration Conflicts**: Moving from one backend to another creates ID collisions

## Proposed Multi-Backend Architecture

### 1. Backend-Qualified Task IDs

#### Format Specification

```typescript
// Format: <backend_prefix>:<local_id>
type BackendQualifiedId = `${BackendPrefix}:${string}`;

// Backend prefixes
type BackendPrefix = 'md' | 'gh' | 'json';

// Examples
const examples: BackendQualifiedId[] = [
  'md:123',    // Markdown backend task 123
  'gh:456',    // GitHub Issues backend task 456
  'json:789'   // JSON file backend task 789
];
```

#### Benefits

- **Unique Identification**: No conflicts across backends
- **Backend Discovery**: Instantly know which backend handles a task
- **Migration Safety**: Can coexist during backend transitions
- **Routing Efficiency**: Direct backend routing without lookup

### 2. Updated TaskService Architecture

```typescript
interface MultiBackendTaskService {
  // Backend registration and management
  registerBackend(backend: TaskBackend): void;
  unregisterBackend(backendName: string): void;
  getAvailableBackends(): string[];
  getDefaultBackend(): string;
  setDefaultBackend(backendName: string): void;

  // Task operations with automatic backend routing
  getTask(qualifiedId: BackendQualifiedId): Promise<Task>;
  createTask(spec: TaskSpec, backend?: string): Promise<Task>;
  updateTaskStatus(qualifiedId: BackendQualifiedId, status: string): Promise<void>;
  deleteTask(qualifiedId: BackendQualifiedId): Promise<boolean>;

  // Cross-backend operations
  listAllTasks(): Promise<Task[]>;
  listTasksByBackend(backend: string): Promise<Task[]>;
  searchTasks(query: string, backends?: string[]): Promise<Task[]>;

  // Backend routing utilities
  parseTaskId(id: string): { backend: string; localId: string } | null;
  getBackendForTask(qualifiedId: BackendQualifiedId): TaskBackend;
  isValidTaskId(id: string): boolean;

  // Migration utilities
  migrateTask(fromId: BackendQualifiedId, toBackend: string): Promise<BackendQualifiedId>;
  bulkMigrate(fromBackend: string, toBackend: string): Promise<MigrationResult>;
}
```

### 3. Backend Interface Updates

```typescript
interface TaskBackend {
  // Existing methods with enhanced ID handling
  name: string;
  prefix: BackendPrefix; // New: backend prefix for qualified IDs

  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(localId: string): Promise<Task | null>; // Uses local ID within backend
  createTask(spec: TaskSpec): Promise<Task>;
  updateTaskStatus(localId: string, status: string): Promise<void>;
  deleteTask(localId: string): Promise<boolean>;

  // New: ID generation and validation
  generateLocalId(): Promise<string>;
  isValidLocalId(id: string): boolean;

  // Migration support
  exportTask(localId: string): Promise<TaskExportData>;
  importTask(data: TaskExportData): Promise<Task>;
}
```

### 4. Session Management Updates

#### Session Naming Strategy

```typescript
// Current: "task#123"
// Proposed: "task#md:123"

interface SessionRecord {
  session: string; // "task#md:123"
  taskId: BackendQualifiedId; // "md:123"
  backend: string; // "md"
  // ... other fields
}

// Session name generation
function generateSessionName(taskId: BackendQualifiedId): string {
  return `task#${taskId}`;
}

// Examples:
// taskId: "md:123" → session: "task#md:123"
// taskId: "gh:456" → session: "task#gh:456"
```

#### Session Auto-Detection Updates

```typescript
function detectSessionFromPath(cwd: string): SessionInfo | null {
  // Parse path like: /sessions/task#md:123/
  const match = cwd.match(/\/sessions\/task#([^:]+):(\d+)\//);
  if (match) {
    const [, backend, localId] = match;
    return {
      taskId: `${backend}:${localId}`,
      backend,
      localId
    };
  }
  return null;
}
```

### 5. Git Operations Updates

#### Branch Naming

```typescript
// Current branch names
const current = [
  'task#123',
  'pr/task#123'
];

// Updated branch names
const updated = [
  'task#md:123',     // Session branch
  'pr/task#md:123'   // PR branch
];

// Branch name generation
function generateBranchName(taskId: BackendQualifiedId, type: 'session' | 'pr'): string {
  const prefix = type === 'pr' ? 'pr/' : '';
  return `${prefix}task#${taskId}`;
}
```

#### Git Operations Impact

```typescript
// All git operations need updates for qualified IDs
interface GitOperations {
  createBranch(taskId: BackendQualifiedId): Promise<void>;
  preparePR(taskId: BackendQualifiedId): Promise<void>;
  mergePR(taskId: BackendQualifiedId): Promise<void>;
  cleanupBranches(taskId: BackendQualifiedId): Promise<void>;
}
```

### 6. File System Organization

#### Backend-Specific Directory Structure

```
process/
├── tasks/
│   ├── md/                    # Markdown backend tasks
│   │   ├── 123-title.md
│   │   └── 124-other.md
│   ├── gh/                    # GitHub Issues backend (specs only)
│   │   ├── 456-issue.md
│   │   └── 457-feature.md
│   └── json/                  # JSON backend tasks
│       ├── 789-task.md
│       └── 790-bug.md
└── sessions/
    ├── task#md:123/          # Backend-qualified session dirs
    ├── task#gh:456/
    └── task#json:789/
```

#### Path Generation Updates

```typescript
// Updated task spec path generation
function getTaskSpecPath(taskId: BackendQualifiedId, title: string): string {
  const { backend, localId } = parseTaskId(taskId);
  const normalizedTitle = normalizeTitle(title);
  return join('process', 'tasks', backend, `${localId}-${normalizedTitle}.md`);
}

// Session directory path generation
function getSessionPath(taskId: BackendQualifiedId): string {
  return join('sessions', `task#${taskId}`);
}
```

### 7. CLI Command Updates

#### Command Schema Updates

```typescript
// All CLI commands need to support qualified task IDs
const taskIdParam = z.union([
  z.string().regex(/^[a-z]+:\d+$/),  // Qualified: "md:123"
  z.string().regex(/^\d+$/),         // Unqualified: "123" (backward compatibility)
]);

// Backend parameter for new tasks
const backendParam = z.enum(['md', 'gh', 'json']).optional();

// Examples
interface TaskGetParams {
  taskId: string;  // Accepts "md:123" or "123"
  backend?: string; // For unqualified ID resolution
}

interface TaskCreateParams {
  title: string;
  description?: string;
  backend?: string; // Which backend to create in
}
```

#### CLI Command Examples

```bash
# Using qualified task IDs
minsky tasks get md:123
minsky tasks status set gh:456 done
minsky session start --task md:123

# Backward compatibility with unqualified IDs
minsky tasks get 123 --backend md
minsky tasks get 123  # Auto-detects backend

# Cross-backend operations
minsky tasks list --all-backends
minsky tasks list --backend gh
minsky tasks search "bug" --backends md,gh

# Migration commands
minsky tasks migrate md:123 --to-backend gh
minsky tasks migrate-all --from md --to gh
```

## Implementation Strategy

### Phase 1: Foundation (High Priority)

1. **Task ID System Redesign**
   - Implement `BackendQualifiedId` type and utilities
   - Create parsing, validation, and formatting functions
   - Add backward compatibility for unqualified IDs

2. **Backend Interface Updates**
   - Add `prefix` property to TaskBackend interface
   - Update all backend implementations
   - Add ID generation and validation methods

3. **TaskService Multi-Backend Refactor**
   - Replace single `currentBackend` with routing system
   - Implement backend registration and management
   - Add cross-backend operation support

### Phase 2: System Integration (High Priority)

1. **Session Management Updates**
   - Update session naming for qualified IDs
   - Modify session records and database schema
   - Update auto-detection mechanisms

2. **Git Operations Updates**
   - Update branch naming schemes
   - Modify PR, merge, and cleanup operations
   - Update all git command integrations

3. **File System Migration**
   - Implement backend-specific directory structure
   - Create migration utilities for existing files
   - Update path generation functions

### Phase 3: CLI and Compatibility (Medium Priority)

1. **CLI Schema Updates**
   - Update all command schemas for qualified IDs
   - Add backend parameter support
   - Implement backward compatibility logic

2. **Migration Tools**
   - Create task ID conversion utilities
   - Implement file system reorganization scripts
   - Add session record migration tools

3. **Backward Compatibility Layer**
   - Support unqualified IDs during transition
   - Auto-detection for legacy task references
   - Graceful degradation mechanisms

### Phase 4: Testing and Documentation (Medium Priority)

1. **Comprehensive Testing**
   - Unit tests for all new components
   - Integration tests across backends
   - Migration testing scenarios

2. **Documentation Updates**
   - Update all documentation for qualified IDs
   - Create migration guides
   - Add troubleshooting documentation

## Migration Strategy

### Backward Compatibility Approach

```typescript
// Support both qualified and unqualified IDs during transition
interface LegacyTaskIdResolver {
  resolveTaskId(input: string, fallbackBackend?: string): BackendQualifiedId;
  isQualifiedId(input: string): boolean;
  migrateUnqualifiedId(input: string, backend: string): BackendQualifiedId;
}

// Auto-detection for unqualified IDs
async function resolveUnqualifiedId(id: string): Promise<BackendQualifiedId> {
  // 1. Check current default backend
  // 2. Search all backends for the ID
  // 3. Use user-configured preferences
  // 4. Prompt user if ambiguous
}
```

### Migration Timeline

1. **Phase 1 (Weeks 1-2)**: Implement core infrastructure
2. **Phase 2 (Weeks 3-4)**: Update system integrations
3. **Phase 3 (Weeks 5-6)**: Add CLI support and compatibility
4. **Phase 4 (Weeks 7-8)**: Testing, documentation, deployment
5. **Phase 5 (Ongoing)**: Monitor, support, deprecate unqualified IDs

## Risk Assessment and Mitigation

### High Risks

1. **Breaking Changes**: Multi-backend changes could break existing workflows
   - **Mitigation**: Comprehensive backward compatibility, staged rollout

2. **Data Loss**: Migration errors could lose task data
   - **Mitigation**: Backup systems, validation, rollback procedures

3. **Performance Impact**: Multiple backends could slow operations
   - **Mitigation**: Efficient routing, caching, async operations

### Medium Risks

1. **User Confusion**: New ID format may confuse users
   - **Mitigation**: Clear documentation, gradual transition, help commands

2. **File Path Issues**: Longer paths may hit OS limits
   - **Mitigation**: Short prefixes, path compression, validation

3. **CLI Complexity**: More parameters may complicate commands
   - **Mitigation**: Smart defaults, auto-detection, simplified workflows

## Success Metrics

### Technical Metrics

- All tests pass with multi-backend support
- Zero data loss during migration
- Performance within 10% of current system
- 100% backward compatibility during transition

### User Experience Metrics

- CLI commands work with both qualified and unqualified IDs
- Migration tools successfully convert existing tasks
- Documentation covers all migration scenarios
- User confusion incidents < 5% of total usage

## Conclusion

The multi-backend task system represents a significant architectural improvement that will enable safe migration between task backends while maintaining system integrity and user experience. The proposed design provides a clear path forward with minimal disruption to existing workflows while enabling powerful new capabilities for task management across multiple systems.

Implementation should proceed in phases with careful attention to backward compatibility and migration safety. The investment in this architecture will pay dividends in system flexibility and user confidence during backend transitions.
