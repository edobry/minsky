# Add GitHub Issues Support as Task Backend

## Status

IN-PROGRESS

## ⚠️ DEPENDENCY UPDATE: Multi-Backend Architecture Required

**PREREQUISITE**: Task #356 "Implement Multi-Backend Task System Architecture" must be completed before this GitHub Issues backend can be properly integrated. This task now focuses on adapting the existing GitHub Issues implementation to work within the multi-backend architecture.

### Multi-Backend Architecture Changes Required

#### 1. Backend-Qualified Task IDs

**Current**: Task IDs are simple numeric strings (`"123"`, `"456"`)
**Required**: Task IDs must include backend qualification (`"md:123"`, `"gh:456"`, `"json:789"`)

#### 2. Task ID Format Specification

```
Format: <backend_prefix>:<task_id>
Examples:
- `md:123` - Markdown backend task 123
- `gh:456` - GitHub Issues backend task 456
- `json:789` - JSON file backend task 789
```

#### 3. System-Wide Impact Areas

**Session Management:**
- Session names: `task#123` → `task#md:123`
- Session records must store backend information
- Auto-detection must handle backend-qualified IDs

**Git Operations:**
- Branch names: `task#123` → `task#md:123`
- PR branches: `pr/task#123` → `pr/task#md:123`
- Branch cleanup operations must handle qualified names

**File System Organization:**
- Task spec paths: `process/tasks/123-title.md` → `process/tasks/md/123-title.md`
- Session workspaces: `/sessions/task#123/` → `/sessions/task#md:123/`
- Backend-specific directory structures

**CLI Commands:**
- All task ID parameters must accept qualified format
- Backend auto-detection from task ID
- Cross-backend task operations

#### 4. TaskService Architecture Changes

**Current**: Single `currentBackend` with all operations routed through it
**Required**: Multi-backend routing system

```typescript
interface TaskService {
  // Route operations to correct backend based on task ID
  getTask(qualifiedId: string): Promise<Task>

  // Backend selection for new tasks
  createTask(spec: TaskSpec, backend?: string): Promise<Task>

  // Cross-backend operations
  listAllTasks(): Promise<Task[]> // From all backends
  listTasksByBackend(backend: string): Promise<Task[]>

  // Backend management
  getAvailableBackends(): string[]
  getBackendForTask(qualifiedId: string): string
}
```

#### 5. Migration Strategy Requirements

**Backward Compatibility:**
- Support unqualified IDs during transition period
- Auto-detect backend for existing unqualified IDs
- Graceful fallback mechanisms

**Migration Process:**
1. Implement backend-qualified ID system
2. Add migration utilities to convert existing tasks
3. Update all system references to use qualified IDs
4. Provide transition period with dual support
5. Deprecate unqualified ID support

### Updated Implementation Plan

#### Phase 1: Multi-Backend Infrastructure (EXPANDED)

1. **Backend-Qualified ID System**
   - Design qualified ID format and validation
   - Update task ID utilities for parsing/formatting
   - Implement backend prefix registration system

2. **TaskService Multi-Backend Routing**
   - Replace single `currentBackend` with routing system
   - Implement backend selection and task routing
   - Add cross-backend operation support

3. **Session Management Updates**
   - Update session names to include backend qualification
   - Modify session records to store backend information
   - Update auto-detection for qualified IDs

#### Phase 2: GitHub Issues Backend Implementation

1. **GitHubIssuesTaskBackend Class** ✅ COMPLETED
   - Implements TaskBackend interface
   - GitHub API integration with issue mapping
   - Status synchronization via labels

2. **Configuration Management**
   - GitHub token authentication
   - Repository selection and validation
   - Label management and creation

#### Phase 3: System Integration Updates

1. **CLI Command Updates**
   - Update all schemas to support qualified task IDs
   - Add backend parameter support
   - Implement cross-backend operations

2. **Git Operations Updates**
   - Update branch naming for qualified IDs
   - Modify PR and merge operations for backend-qualified branches
   - Update cleanup operations

3. **File System Organization**
   - Implement backend-specific directory structures
   - Update spec path generation
   - Add migration utilities for existing files

#### Phase 4: Migration and Compatibility

1. **Migration Utilities**
   - Task ID conversion tools
   - File system reorganization scripts
   - Session record migration

2. **Backward Compatibility**
   - Dual ID support during transition
   - Automatic backend detection for unqualified IDs
   - Graceful degradation mechanisms

### Critical Issues and Challenges

#### 1. ID Conflict Resolution

**Problem**: Same numeric ID may exist across multiple backends
**Impact**: System confusion, incorrect task routing
**Solution**: Enforce strict backend qualification, add conflict detection

#### 2. Session Name Uniqueness

**Problem**: Session names like `task#md:123` may become unwieldy
**Impact**: User experience degradation, command line usability
**Solution**: Design concise but unambiguous naming scheme

#### 3. File Path Length Limits

**Problem**: Backend-qualified paths may exceed filesystem limits
**Impact**: File creation failures, cross-platform compatibility issues
**Solution**: Use short backend prefixes, path compression strategies

#### 4. Backward Compatibility Complexity

**Problem**: Supporting both qualified and unqualified IDs simultaneously
**Impact**: Code complexity, potential bugs, user confusion
**Solution**: Well-defined migration timeline, clear documentation

#### 5. Cross-Backend Operations

**Problem**: Some operations may need to work across multiple backends
**Impact**: Complex implementation, performance implications
**Solution**: Careful API design, async operation handling

### Required Follow-up Tasks

1. **Task ID System Redesign** (High Priority)
   - Design backend-qualified ID format
   - Implement parsing and validation utilities
   - Update all ID references system-wide

2. **TaskService Multi-Backend Refactor** (High Priority)
   - Replace single-backend architecture
   - Implement backend routing system
   - Add cross-backend operation support

3. **Session Management Updates** (High Priority)
   - Update session naming for qualified IDs
   - Modify session records and operations
   - Update auto-detection mechanisms

4. **CLI Schema Updates** (Medium Priority)
   - Update all command schemas for qualified IDs
   - Add backend parameter support
   - Implement backward compatibility

5. **Git Operations Updates** (Medium Priority)
   - Update branch naming schemes
   - Modify PR and merge operations
   - Update cleanup procedures

6. **File System Migration** (Medium Priority)
   - Design backend-specific directory structure
   - Implement migration utilities
   - Add path generation updates

7. **Documentation and Testing** (Medium Priority)
   - Update all documentation for qualified IDs
   - Add comprehensive test coverage
   - Create migration guides

### Implementation Status

#### ✅ Completed

- **GitHubIssuesTaskBackend Class**: Fully implemented with all TaskBackend interface methods
- **GitHub API Integration**: Using @octokit/rest for GitHub Issues API communication
- **Task-Issue Mapping**: Complete mapping between Minsky tasks and GitHub issues
- **Status Label System**: Configurable status labels (minsky:todo, minsky:in-progress, etc.)
- **Test Suite**: Comprehensive test coverage for all pure functions
- **Error Handling**: Robust error handling for API failures and network issues

#### 🔍 Questions Requiring Clarification

Before proceeding with multi-backend implementation:

1. **Backend Prefix Strategy**: What short prefixes should be used for each backend?
   - `md:` for markdown, `gh:` for GitHub, `json:` for JSON file?
   - Alternative schemes (numeric, alphabetic)?

2. **Migration Timeline**: What is the timeline for transitioning to qualified IDs?
   - Immediate full transition or gradual migration?
   - Backward compatibility duration?

3. **Session Naming Strategy**: How should qualified IDs be handled in session names?
   - `task#md:123` or alternative format?
   - URL encoding for special characters?

4. **Cross-Backend Operations**: Which operations should work across multiple backends?
   - Task listing, searching, status updates?
   - Migration between backends?

### Updated Scope Assessment

**Original Scope**: Large (8-12 hours)
**Updated Scope**: Medium (4-8 hours) - Reduced due to dependency on Task #356

The scope has been significantly reduced because:
- Core multi-backend architecture will be implemented in Task #356
- This task now focuses on adapting existing GitHub backend implementation
- System-wide changes are handled by the prerequisite task
- Less architectural complexity due to foundation being laid separately

This task now requires completion of Task #356 before implementation can begin.

## Original GitHub Issues Implementation (Completed)

### 🔧 Technical Notes

The current implementation:

- ✅ Implements all required TaskBackend interface methods
- ✅ Handles GitHub API authentication with configurable tokens
- ✅ Maps task statuses to GitHub issue states and labels
- ✅ Supports both issue creation and updates
- ✅ Includes comprehensive error handling
- ✅ Has 100% test coverage for pure functions

The backend is **functionally complete** and ready for integration once multi-backend architecture is implemented.

## Priority

Medium (depends on completion of Task #356 first)

## Summary

Adapt and integrate the existing GitHub Issues backend implementation to work within the multi-backend task system architecture (Task #356), enabling GitHub Issues as a task backend option with backend-qualified task IDs.

## Description

**PREREQUISITE**: This task depends on Task #356 "Implement Multi-Backend Task System Architecture" and cannot begin until that foundation is complete.

Currently, a GitHub Issues backend has been implemented but only works within the single-backend architecture. This task adapts the existing implementation to work within the new multi-backend system, enabling users to:

1. Create tasks as GitHub issues with backend-qualified IDs (`gh:123`)
2. Update task status by modifying issue state and labels
3. List and filter GitHub tasks alongside other backends
4. Sync task metadata between Minsky and GitHub issues
5. Support issue assignments, labels, and milestones
6. Migrate tasks from other backends to GitHub Issues safely

## Requirements

### Core Multi-Backend Features

- [ ] Design backend-qualified task ID system (`backend:id` format)
- [ ] Implement multi-backend TaskService routing architecture
- [ ] Update all system references to use qualified task IDs
- [ ] Create migration utilities for existing unqualified tasks
- [ ] Support cross-backend operations (list all, search, etc.)

### GitHub Issues Backend Features

- [x] Implement GitHub Issues API integration
- [x] Create task-to-issue mapping functionality
- [x] Support issue creation from task specifications
- [x] Implement issue status synchronization (open/closed/draft)
- [x] Add support for GitHub issue labels for task categorization
- [x] Handle issue assignments and milestone tracking

### System Integration Updates

- [ ] Update session management for backend-qualified IDs
- [ ] Update git operations (branch names, PR operations)
- [ ] Update CLI command schemas for qualified task IDs
- [ ] Update file system organization for backend-specific structures
- [ ] Add backward compatibility during migration period

### Configuration & Migration

- [ ] Add GitHub repository configuration options
- [ ] Implement GitHub token management
- [ ] Support for repository selection and validation
- [ ] Create task ID migration utilities
- [ ] Implement graceful fallback mechanisms

### Error Handling

- [x] Handle GitHub API rate limiting
- [x] Manage network connectivity issues
- [x] Provide clear error messages for authentication failures
- [ ] Add cross-backend error handling and recovery
- [ ] Implement migration validation and rollback

## Acceptance Criteria

1. Users can create tasks in any available backend with qualified IDs
2. Task operations are automatically routed to the correct backend
3. Session names and branch names support backend-qualified task IDs
4. Existing tasks can be migrated to new backend system without conflicts
5. Cross-backend operations (listing, searching) work seamlessly
6. GitHub backend integrates seamlessly with multi-backend architecture
7. All CLI commands support backend-qualified task IDs
8. Migration utilities successfully convert existing unqualified tasks
9. Backward compatibility is maintained during transition period
10. System performance remains acceptable with multiple backends

## Dependencies

- Multi-backend architecture design and implementation
- Task ID system redesign for backend qualification
- Session management updates for qualified IDs
- Git operations updates for qualified branch names
- CLI schema updates for backward compatibility
- GitHub API client library
- Authentication token management
- Existing task backend interface

## Estimated Effort

Medium (4-8 hours) - reduced scope due to dependency on Task #356 for multi-backend architecture

## Notes

- Requires careful architectural planning to avoid breaking changes
- Multi-backend support is prerequisite for safe GitHub backend migration
- Should maintain compatibility with existing markdown backend
- Consider GitHub webhooks for real-time synchronization
- May need to handle GitHub-specific features like issue templates
- Migration strategy critical for production deployment

## Related Tasks

- **#356**: Implement Multi-Backend Task System Architecture (PREREQUISITE - must complete first)
- #091: Enhance SessionDB with Multiple Backend Support
- #048: Establish a Rule Library System
- #283: Separate Task ID Storage from Display Format (foundation for multi-backend)

## Work Log

- 2025-01-17: Initial GitHub Issues backend implementation completed
  - Implemented full GitHub Issues task backend with API integration
  - Added comprehensive test suite with mocked GitHub API responses
  - Integrated with existing task service using factory pattern
  - Added proper configuration and environment variable support (GITHUB_TOKEN)
  - All tests passing with GitHub backend fully integrated
  - Note: Dynamic imports were used in the implementation which violates the no-dynamic-imports rule
    This has been tracked as a separate task #145 for cleanup
  - Created task #146 to fix session PR command import bug discovered during implementation

- 2025-01-28: Multi-backend architecture analysis completed and separated into prerequisite task
  - Identified need for backend-qualified task IDs to prevent conflicts during migration
  - Analyzed system-wide impact on sessions, git operations, file paths
  - Created Task #356 "Implement Multi-Backend Task System Architecture" as prerequisite
  - Reduced scope of this task to focus on GitHub backend adaptation only
  - Updated priority and effort estimates to reflect dependency
  - GitHub backend implementation remains complete and ready for integration
