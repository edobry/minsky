# Implement Multi-Backend Task System Architecture

## Context

## Summary

Implement comprehensive multi-backend task system architecture to support concurrent use of multiple task backends (markdown, GitHub Issues, JSON) with backend-qualified task IDs, preventing ID conflicts during backend migration.

## Description

Currently, Minsky supports only a single active task backend at a time, creating significant challenges for migrating from one backend to another due to potential task ID conflicts. This task implements a multi-backend architecture that allows multiple task backends to coexist safely with backend-qualified task IDs.

The system will use qualified task IDs in the format `<backend_prefix>:<local_id>` (e.g., `md:123`, `gh:456`, `json:789`) to ensure unique identification across all backends while enabling seamless backend routing and migration capabilities.

## Requirements

### Phase 1: Core Infrastructure (High Priority)

#### 1.1 Backend-Qualified Task ID System
- [ ] **Start with comprehensive tests** following test-driven development approach for all new ID functionality
- [ ] Implement `BackendQualifiedId` type system with validation
- [ ] Create parsing utilities (`parseTaskId`, `isQualifiedId`)
- [ ] Add formatting utilities (`formatTaskId`, `formatForDisplay`)
- [ ] Support backward compatibility with unqualified IDs
- [ ] Add validation and error handling for malformed IDs

#### 1.2 TaskBackend Interface Updates
- [ ] Add `prefix` property to TaskBackend interface (backends define their own prefixes)
- [ ] Update all existing backends (markdown, JSON, GitHub) to include prefix property
- [ ] Implement local ID generation and validation methods
- [ ] Add migration support methods (`exportTask`, `importTask`)
- [ ] Update backend capability discovery for qualified IDs

#### 1.3 TaskService Multi-Backend Architecture
- [ ] Replace single `currentBackend` with multi-backend routing system
- [ ] Implement backend registration and management
- [ ] Add automatic task routing based on qualified IDs
- [ ] Implement cross-backend operations (list all, search across backends)
- [ ] Add backend selection for new task creation
- [ ] Create migration utilities between backends with collision tracking

### Phase 2: System Integration (High Priority)

#### 2.1 Session Management Updates
- [ ] Update session naming to support qualified IDs (`task#md:123`)
- [ ] Modify SessionRecord to store backend information
- [ ] Update session auto-detection for qualified task IDs
- [ ] Update session path resolution for backend-qualified directories
- [ ] Ensure backward compatibility with existing sessions

#### 2.2 Git Operations Updates
- [ ] **CRITICAL**: Design git-compatible branch naming strategy (colons `:` are forbidden in git branch names)
- [ ] Use alternative format for branches: `task-md-123` instead of `task#md:123`
- [ ] Implement branch name conversion utilities between session names and git branch names
- [ ] Update PR preparation and merge operations for new branch format
- [ ] Update branch cleanup operations for qualified names
- [ ] Update git command integrations throughout the system
- [ ] Ensure git operations work with both qualified and legacy IDs

#### 2.3 File System Organization
- [ ] Implement backend-specific directory structure (`process/tasks/md/`, `process/tasks/gh/`)
- [ ] Update task spec path generation for backend qualification
- [ ] Create session workspace paths with qualified IDs (`sessions/task#md:123/`)
- [ ] Implement file system migration utilities
- [ ] **Add migration collision detection and reporting system**
- [ ] Generate detailed migration reports for manual reconciliation of conflicts
- [ ] Ensure cross-platform compatibility for new path structures

### Phase 3: CLI and Compatibility (Medium Priority)

#### 3.1 CLI Command Schema Updates
- [ ] **Leverage Task #329 schema libraries** for consistent cross-interface type composition
- [ ] Update all command schemas to accept qualified task IDs using domain-wide schema patterns
- [ ] Add backend parameter support for new task creation
- [ ] Implement unqualified ID resolution with fallback logic
- [ ] Add cross-backend command operations (`--all-backends`, `--backend`)
- [ ] Update help text and error messages for qualified IDs

#### 3.2 Backward Compatibility Layer
- [ ] Implement unqualified ID auto-resolution
- [ ] Support legacy session names and branch names
- [ ] Add migration prompts and assistance for users
- [ ] Create compatibility warnings for deprecated patterns
- [ ] Ensure graceful degradation for edge cases

### Phase 4: Migration and Tooling (Medium Priority)

#### 4.1 Migration Utilities
- [ ] Create task ID conversion tools
- [ ] Implement file system reorganization scripts
- [ ] Add session record migration tools
- [ ] Create bulk migration commands
- [ ] **Implement collision tracking system that logs conflicts and generates reports**
- [ ] Add validation and rollback capabilities
- [ ] Create migration summary reports for manual conflict resolution

#### 4.2 Testing and Documentation
- [ ] Comprehensive unit tests for all new components
- [ ] Integration tests across multiple backends
- [ ] Migration scenario testing
- [ ] Update all documentation for qualified IDs
- [ ] Create migration guides and troubleshooting docs

## Implementation Details

### Backend-Qualified ID Format

```typescript
type BackendPrefix = 'md' | 'gh' | 'json';
type BackendQualifiedId = `${BackendPrefix}:${string}`;

// Examples:
// md:123   - Markdown backend task 123
// gh:456   - GitHub Issues backend task 456
// json:789 - JSON file backend task 789
```

### Git-Compatible Branch Naming Strategy

```typescript
// Session names: task#md:123 (for display/storage)
// Git branch names: task-md-123 (git-compatible)
// PR branch names: pr/task-md-123

function sessionNameToBranchName(sessionName: string): string {
  // Convert task#md:123 → task-md-123
  return sessionName.replace('#', '-').replace(':', '-');
}

function branchNameToSessionName(branchName: string): string {
  // Convert task-md-123 → task#md:123
  const parts = branchName.split('-');
  if (parts.length >= 3 && parts[0] === 'task') {
    return `task#${parts[1]}:${parts.slice(2).join('-')}`;
  }
  return branchName;
}
```

### Updated TaskService Interface

```typescript
interface MultiBackendTaskService {
  // Backend management
  registerBackend(backend: TaskBackend): void;
  getAvailableBackends(): string[];
  getDefaultBackend(): string;
  
  // Task operations with automatic routing
  getTask(qualifiedId: BackendQualifiedId): Promise<Task>;
  createTask(spec: TaskSpec, backend?: string): Promise<Task>;
  
  // Cross-backend operations
  listAllTasks(): Promise<Task[]>;
  listTasksByBackend(backend: string): Promise<Task[]>;
  
  // Migration utilities with collision tracking
  migrateTask(fromId: BackendQualifiedId, toBackend: string): Promise<BackendQualifiedId>;
  generateMigrationReport(): Promise<MigrationReport>;
}

interface TaskBackend {
  name: string;
  prefix: BackendPrefix; // Each backend defines its own prefix
  // ... other methods
}

interface MigrationReport {
  successful: BackendQualifiedId[];
  conflicts: MigrationConflict[];
  errors: MigrationError[];
  summary: {
    total: number;
    successful: number;
    failed: number;
  };
}
```

### File System Structure

```
process/
├── tasks/
│   ├── md/                    # Markdown backend tasks
│   │   ├── 123-title.md
│   │   └── 124-other.md
│   ├── gh/                    # GitHub Issues backend
│   │   ├── 456-issue.md
│   │   └── 457-feature.md
│   └── json/                  # JSON backend tasks
│       ├── 789-task.md
│       └── 790-bug.md
└── sessions/
    ├── task#md:123/          # Backend-qualified sessions
    ├── task#gh:456/
    └── task#json:789/
```

## Acceptance Criteria

1. **Core Infrastructure**
   - All task operations correctly route to appropriate backend based on qualified ID
   - Backward compatibility maintained for existing unqualified task references
   - No data loss during migration from single to multi-backend system

2. **System Integration**
   - Session names support backend-qualified task IDs
   - Git operations (branches, PRs) work with git-compatible branch names
   - File system organization supports backend-specific structures

3. **User Experience**
   - CLI commands accept both qualified and unqualified task IDs
   - Clear error messages for malformed or missing task IDs
   - Migration tools successfully convert existing tasks
   - **Migration collision reports provide actionable information for manual resolution**

4. **Reliability**
   - All existing tests pass with multi-backend architecture
   - Comprehensive test coverage for new functionality
   - **Test-driven development ensures robust implementation**

## Dependencies

- **Task #329**: Create Domain-Wide Schema Libraries for Cross-Interface Type Composition (provides schema foundation)
- Task ID utilities and validation (building on Task #283)
- Session management system
- Git operations infrastructure
- CLI command schemas
- File system utilities

## Risks and Mitigation

**High Risks:**
1. **Breaking Changes**: Multi-backend changes could break existing workflows
   - *Mitigation*: Comprehensive backward compatibility, staged rollout

2. **Data Loss**: Migration errors could lose task data
   - *Mitigation*: Backup systems, validation, rollback procedures

3. **Git Branch Naming Conflicts**: Invalid characters in branch names
   - *Mitigation*: Git-compatible branch naming strategy using dashes instead of colons

**Medium Risks:**
1. **User Confusion**: New ID format may confuse users
   - *Mitigation*: Clear documentation, gradual transition, help commands

2. **File Path Issues**: Longer paths may hit OS limits
   - *Mitigation*: Short prefixes, path validation

3. **Migration Conflicts**: ID collisions during backend migration
   - *Mitigation*: Collision detection system with detailed reporting for manual resolution

## Related Tasks

- **Task #138**: Add GitHub Issues Support as Task Backend (depends on this task)
- **Task #329**: Create Domain-Wide Schema Libraries for Cross-Interface Type Composition (foundation for CLI schema updates)
- **Task #283**: Separate Task ID Storage from Display Format (foundation)
- **Task #091**: Enhance SessionDB with Multiple Backend Support

## Priority

HIGH - Prerequisite for Task #138 (GitHub Issues Backend)

## Estimated Effort

Extra Large

## Notes

- This task is a prerequisite for Task #138 and should be implemented first
- Careful attention to backward compatibility is essential
- **Start with comprehensive test coverage following test-driven development principles**
- Architecture design document available at `docs/architecture/multi-backend-task-system-design.md`
- Migration strategy should be well-tested before production deployment
- Consider implementing in phases to reduce risk and enable incremental testing
- **Task #329 schema libraries provide the foundation for CLI command schema updates**
- **Git branch naming must avoid colons and other forbidden characters**
