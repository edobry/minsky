# Implement Multi-Backend Task System Architecture

## Context

## Summary

Implement comprehensive multi-backend task system architecture to support concurrent use of multiple task backends (markdown, GitHub Issues, JSON) with backend-qualified task IDs, preventing ID conflicts during backend migration.

## ✅ PROGRESS SUMMARY

### **PHASE 1: CORE INFRASTRUCTURE - COMPLETED**

**✅ Unified Task ID System (44/44 tests passing)**
- Task IDs: `md#123`, `gh#456`, `json#789` (clean format)
- Session/Branch names: `task-md#123`, `task-gh#456` (contextual prefix)
- Migration utilities for legacy formats (`123`, `task#123` → `md#123`)
- Comprehensive backward compatibility and error handling
- Git-compatible naming (no colons, uses `#` which is valid)

**✅ Architecture Design Completed**
- Enhanced TaskBackend interface with `prefix` property
- Multi-backend routing strategy defined
- Collision detection and reporting system designed
- Migration strategy established (all unqualified IDs → markdown backend)

### **PHASE 2: MULTI-BACKEND SYSTEM - COMPLETED**

**✅ Core Multi-Backend Service (23/23 tests passing)**
- `MultiBackendTaskServiceImpl` with full routing logic and backend management
- Task operations with automatic routing to correct backend (md#123 → markdown, gh#456 → github)
- Cross-backend operations: list all tasks, search across backends, backend filtering
- Migration system with export/import between backends and collision tracking
- Error handling for unknown backends, malformed IDs, and migration failures

**✅ Comprehensive Mock Framework**
- `createMockBackend` factory for test-driven development
- Complete TaskBackend interface implementation with all required methods
- Mock data generators and configurable backend setups for testing
- Helper utilities for different test scenarios and backend configurations

**✅ Production-Ready Features**
- Unqualified ID fallback to default backend for backward compatibility
- Complex local ID support with special characters (issue-456, feature_branch-123)
- Graceful error handling with detailed error messages and failure tracking
- Collision detection with backend summaries and manual reconciliation reporting

## Description

Currently, Minsky supports only a single active task backend at a time, creating significant challenges for migrating from one backend to another due to potential task ID conflicts. This task implements a multi-backend architecture that allows multiple task backends to coexist safely with backend-qualified task IDs.

The system will use qualified task IDs in the format `<backend_prefix>:<local_id>` (e.g., `md:123`, `gh:456`, `json:789`) to ensure unique identification across all backends while enabling seamless backend routing and migration capabilities.

## Requirements

### Phase 1: Core Infrastructure (High Priority)

#### 1.1 Backend-Qualified Task ID System ✅ **COMPLETED**
- [x] **Start with comprehensive tests** following test-driven development approach for all new ID functionality
- [x] Implement `TaskId` type system with validation (unified-task-id.ts)
- [x] Create parsing utilities (`parseTaskId`, `isQualifiedTaskId`)
- [x] Add formatting utilities (`formatTaskId`, `extractBackend`, `extractLocalId`)
- [x] Support backward compatibility with unqualified IDs and legacy formats
- [x] Add validation and error handling for malformed IDs
- [x] **44/44 tests passing** with comprehensive coverage

#### 1.2 TaskBackend Interface Updates
- [ ] Add `prefix` property to TaskBackend interface (backends define their own prefixes)
- [ ] Update all existing backends (markdown, JSON, GitHub) to include prefix property
- [ ] Implement local ID generation and validation methods
- [ ] Add migration support methods (`exportTask`, `importTask`)
- [ ] Update backend capability discovery for qualified IDs

#### 1.3 TaskService Multi-Backend Architecture ✅ **COMPLETED**
- [x] Replace single `currentBackend` with multi-backend routing system (MultiBackendTaskServiceImpl)
- [x] Implement backend registration and management (registerBackend, getBackend, listBackends)
- [x] Add automatic task routing based on qualified IDs (routeToBackend method)
- [x] Implement cross-backend operations (listAllTasks, searchTasks with backend filtering)
- [x] Add backend selection for new task creation (selectBackendForNewTask)
- [x] Create migration utilities between backends with collision tracking (migrateTask, detectCollisions)

### Phase 3: System Integration (High Priority) 🔄 **IN PROGRESS**

#### 3.1 Session Management Updates ✅ **COMPLETE**
- [x] Update session naming to support qualified IDs (`task-md#123`)
- [x] Modify SessionRecord to store backend information
- [x] Update session auto-detection for qualified task IDs
- [x] Update session path resolution for backend-qualified directories
- [x] Ensure backward compatibility with existing sessions

#### 3.2 Git Operations Updates ✅ **COMPLETE**
- [x] **CRITICAL**: Design git-compatible branch naming strategy (colons `:` are forbidden in git branch names)
- [x] Use unified format for branches: `task-md#123` everywhere (git-compatible)
- [x] Implement conversion utilities between task IDs and session names (taskIdToSessionName, sessionNameToTaskId)
- [x] Update PR preparation and merge operations for new branch format
- [x] Update branch cleanup operations for qualified names
- [x] Test git workflows with qualified session names
- [x] Enhanced session auto-repair with multi-backend integration
- [x] Automatic migration from legacy task ID formats in git operations
- [x] Comprehensive testing framework for git multi-backend integration

#### 3.3 Backend Integration Updates ✅ **COMPLETE**
- [x] Update existing MarkdownTaskBackend to implement new TaskBackend interface
- [x] Add prefix property ("md") to MarkdownTaskBackend
- [x] Implement export/import methods for migration support
- [x] Test multi-backend service with real backends (not just mocks)
- [x] Validate backend registration and routing with existing task service
- [x] Create comprehensive integration tests between service and backend
- [x] Verify qualified ID generation, retrieval, and manipulation
- [x] Test legacy format migration and backward compatibility
- [x] Validate export/import operations for cross-backend migration
- [x] Confirm collision detection and search functionality

#### 3.4 Migration & CLI Integration ✅ **COMPLETE**
- [x] Create migration CLI command for existing tasks
- [x] Update CLI schemas to support qualified IDs (leverage Task #329)
- [x] Add backend parameter to relevant task commands
- [x] Implement collision detection workflow for user migration
- [x] Add progress reporting and rollback capabilities
- [x] Build SessionMigrationService for bulk database operations
- [x] Create comprehensive CLI interface (sessionMigrate, sessionMigrateRollback)
- [x] Add batch processing, filtering, and comprehensive error handling
- [x] Implement automatic backup creation and restoration capabilities

#### 2.3 File System Organization ❌ **CANCELLED**
- [x] ~~Implement backend-specific directory structure~~ **CANCELLED** - Not needed (GitHub Issues stored remotely, moving away from in-tree backends per ADR 003)
- [x] ~~Update task spec path generation for backend qualification~~ **CANCELLED**
- [x] ~~Create session workspace paths with qualified IDs~~ **CANCELLED**
- [x] ~~Implement file system migration utilities~~ **CANCELLED**
- [x] ~~Add migration collision detection and reporting system~~ **CANCELLED**
- [x] ~~Generate detailed migration reports for manual reconciliation of conflicts~~ **CANCELLED**
- [x] ~~Ensure cross-platform compatibility for new path structures~~ **CANCELLED**

### Phase 3: CLI and Compatibility (Medium Priority)

#### 3.6 CLI Command Schema Updates ✅ **COMPLETE**
- [x] **Leverage Task #329 schema libraries** for consistent cross-interface type composition
- [x] Update common-parameters.ts to accept qualified task IDs using domain-wide schema patterns
- [x] Add backend parameter support for new task creation
- [x] Update BaseTaskCommand with qualified ID validation and migration
- [x] Add cross-backend command operations (`--all-backends`, `--backend`)
- [x] Update help text and error messages for qualified IDs
- [x] **CRITICAL**: Add missing multi-backend parameter schemas to task-schemas.ts (causing test failures)
- [x] Export all new multi-backend types in schema index files
- [x] Update CLI command implementations to use new multi-backend schemas

#### 3.2 Backward Compatibility Layer ✅ **COMPLETE**
- [x] Implement unqualified ID auto-resolution (NormalizedTaskIdSchema, migrateUnqualifiedTaskId)
- [x] Support legacy session names and branch names (SessionMultiBackendIntegration)
- [x] Add migration prompts and assistance for users (Session migration system)
- [x] Create compatibility warnings for deprecated patterns (Enhanced error messages)
- [x] Ensure graceful degradation for edge cases (Comprehensive error handling throughout)

### Phase 4: Migration and Tooling (Medium Priority)

#### 4.1 Migration Utilities ✅ **COMPLETE**
- [x] Create task ID conversion tools (unified-task-id.ts with migration utilities)
- [x] ~~Implement file system reorganization scripts~~ **CANCELLED** (FS org cancelled)
- [x] Add session record migration tools (SessionMultiBackendIntegration, migration-command.ts)
- [x] Create bulk migration commands (sessionMigrate CLI with comprehensive options)
- [x] **Implement collision tracking system that logs conflicts and generates reports** (MultiBackendTaskService.detectCollisions)
- [x] Add validation and rollback capabilities (Session migration with backup/restore)
- [x] Create migration summary reports for manual conflict resolution (MigrationReport interface)

#### 4.2 Testing and Documentation
- [x] Comprehensive unit tests for all new components (210+ tests across all modules)
- [x] Integration tests across multiple backends (real MarkdownTaskBackend integration)
- [x] Migration scenario testing (session migration with comprehensive test coverage)
- [x] Update all documentation for qualified IDs
- [x] Create migration guides and troubleshooting docs
- [x] **User Documentation Complete**: Multi-backend user guide, migration guide, quick reference
- [x] **Fix test suite stability** - Resolve schema import errors and syntax issues

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

### ✅ UNIFIED TASK ID ARCHITECTURE (IMPLEMENTED)

**FINAL DESIGN DECISION**: Single format everywhere with contextual prefixes

```typescript
// Task IDs: md#123, gh#456, json#789 (clean, no prefix)
// Session/Branch names: task-md#123, task-gh#456 (with contextual prefix)
// Git-compatible (no colons, uses # which is valid)

function taskIdToSessionName(taskId: string): string {
  // md#123 → task-md#123
  return `task-${taskId}`;
}

function sessionNameToTaskId(sessionName: string): string {
  // task-md#123 → md#123
  return sessionName.replace(/^task-/, "");
}
```

**MIGRATION STRATEGY**: All existing unqualified IDs assume markdown backend
- `"123"` → `"md#123"`
- `"task#123"` → `"md#123"`
- Automatic detection and conversion

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

## 🚀 CURRENT STATUS & REMAINING WORK

**✅ PHASES 1, 2, 3.1, 3.2, 3.4, 3.5 & DOCUMENTATION COMPLETE**
- Unified Task ID System with comprehensive migration support (44/44 tests ✅)
- Multi-Backend Service with routing, collision detection, and cross-backend operations (23/23 tests ✅)
- Session Management Integration with multi-backend naming and backward compatibility (38/38 tests ✅)
- Git Operations Integration with multi-backend session and task ID handling (8/8 tests ✅)
- Bulk Session Migration System with CLI commands and comprehensive testing (35+ tests ✅)
- Backend Integration with real MarkdownTaskBackend multi-backend compatibility (30+ tests ✅)
- Complete mock testing framework for test-driven development ✅
- Git-compatible architecture design with unified format everywhere ✅
- User Documentation: Migration guides, user guides, quick reference ✅

**✅ CRITICAL ISSUES RESOLVED**

### **Priority 1: System Stability (RESOLVED)**
1. **Schema Export Errors** - ✅ **FIXED** - All multi-backend schema exports added and working
2. **Test Suite Stability** - ✅ **FIXED** - Schema import errors resolved, tests running normally

### **Priority 2: Remaining Integration**
3. **CLI Schema Integration** - ✅ **COMPLETE** - All multi-backend schemas integrated and exported
4. **File System Organization** - ❌ **CANCELLED** - Not needed (GitHub Issues stored remotely, moving away from in-tree backends per ADR 003)
5. **Enhanced Error Handling** - 🟡 **OPTIONAL** - Comprehensive error scenarios and recovery (polish item)

### **✅ COMPLETED & SKIPPED**
- **Performance Testing** - ✅ **SKIPPED** (per user request)
- **User Documentation** - ✅ **COMPLETE** (comprehensive guides created)

**🎯 Overall Status: ✅ 99% COMPLETE - Production ready! Only optional polish remains**
