# Add GitHub Issues Support as Task Backend

## Status

IN-PROGRESS

## ⚠️ CRITICAL UPDATE: Multi-Backend Architecture Required

**NEW REQUIREMENT**: Support for multiple concurrent task backends has been identified as essential for migration from local markdown backend to GitHub Issues backend. This significantly expands the scope and complexity of this task.

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
**Updated Scope**: Extra Large (20-30 hours)

The multi-backend requirement significantly increases complexity:
- Core architecture changes required
- System-wide ID reference updates needed
- Migration strategy and tooling required
- Extensive testing across multiple scenarios
- Backward compatibility implementation

This task now requires careful coordination with system architecture to ensure clean implementation without breaking existing functionality.

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

High (increased due to architectural impact)

## Summary

Implement GitHub Issues integration as a task backend option AND design/implement multi-backend architecture to support concurrent use of multiple task backends with backend-qualified task IDs.

## Description

Currently, Minsky supports markdown and basic GitHub backend for task management. This task involves implementing full GitHub Issues support as a task backend AND creating the infrastructure for multiple concurrent backends with qualified task IDs, enabling users to:

1. Create tasks as GitHub issues with backend-qualified IDs
2. Update task status by modifying issue state and labels
3. List and filter tasks from multiple backends simultaneously
4. Sync task metadata between Minsky and GitHub issues
5. Support issue assignments, labels, and milestones
6. Migrate existing tasks to new backend without ID conflicts

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

Extra Large (20-30 hours) - increased due to multi-backend architecture requirements

## Notes

- Requires careful architectural planning to avoid breaking changes
- Multi-backend support is prerequisite for safe GitHub backend migration
- Should maintain compatibility with existing markdown backend
- Consider GitHub webhooks for real-time synchronization
- May need to handle GitHub-specific features like issue templates
- Migration strategy critical for production deployment

## Related Tasks

- #091: Enhance SessionDB with Multiple Backend Support (prerequisite)
- #048: Establish a Rule Library System
- NEW: Design Multi-Backend Task ID System (prerequisite)
- NEW: Implement TaskService Multi-Backend Architecture (prerequisite)
- NEW: Update Session Management for Qualified Task IDs (prerequisite)
- NEW: Update Git Operations for Backend-Qualified Branches (prerequisite)

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

- 2025-01-[DATE]: Multi-backend architecture analysis completed
  - Identified need for backend-qualified task IDs to prevent conflicts
  - Analyzed system-wide impact on sessions, git operations, file paths
  - Expanded scope to include full multi-backend architecture design
  - Updated requirements and implementation plan for comprehensive solution
  - Identified critical issues and required follow-up tasks
  - Increased effort estimate due to architectural complexity
