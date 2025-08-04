# Task #357: Integrate GitHub Issues Backend with Repository Backend Architecture

## Priority

**HIGH** - Blocks full GitHub Issues backend deployment

## Effort Estimate

**Large (12-16 hours)**

## Summary

Complete the integration of the production-ready GitHub Issues backend (Task #138) with the repository backend auto-detection and multi-backend task system architecture (Task #161 Phase 0 + Task #356). This enables end-to-end GitHub Issues workflow with proper backend separation and qualified task IDs.

## Context

**Background**: Task #138 delivered a production-ready GitHub Issues backend with comprehensive documentation, CLI tooling, and integration tests. However, it requires repository backend integration to function in practice, as the GitHub Issues task backend cannot be used with local repository backends.

**Architectural Gap**: The GitHub Issues backend currently errors out when used with local repository backends, correctly implementing the intended architecture separation. However, the foundational repository backend auto-detection and multi-backend task ID system needed to make it functional are still pending.

**Dependencies Completed**:

- ✅ Task #138: GitHub Issues backend implementation (production-ready)
- ✅ Task #161: GitHub PR workflow specification (contains Phase 0 repository backend design)
- ✅ Task #356: Multi-backend task system architecture design

## Objectives

### Primary Goal

Enable end-to-end GitHub Issues task backend usage by implementing the repository backend integration layer designed in Task #161 Phase 0 and the multi-backend task ID system from Task #356.

### Success Criteria

1. **Repository Backend Auto-Detection**: Automatically detect and instantiate GitHub repository backend when working in GitHub repositories
2. **Task Backend Compatibility**: GitHub Issues task backend works seamlessly when GitHub repository backend is detected
3. **Multi-Backend Task IDs**: Implement backend-qualified task IDs (`gh#123`, `md#456`) to prevent conflicts
4. **Backward Compatibility**: Existing unqualified task IDs continue to work during transition
5. **End-to-End Workflow**: Complete task creation → session management → PR workflow using GitHub Issues

## Technical Requirements

### 1. Repository Backend Auto-Detection (from Task #161 Phase 0.1)

Implement simple, immediate git remote detection (KISS principle):

```typescript
function detectRepositoryBackend(workdir: string): RepositoryBackendType {
  const remote = execSync("git remote get-url origin", { cwd: workdir });

  if (remote.includes("github.com")) return "github";
  if (remote.includes("gitlab.com")) return "gitlab";
  return remote.startsWith("/") ? "local" : "remote";
}
```

**Implementation Points**:

- ✅ No chained auto-detection (rejected complex approach)
- ✅ Only check immediate git remote URL
- ✅ Simple string matching for GitHub detection
- ✅ Fallback to local/remote as appropriate

### 2. Repository Backend Integration with TaskService (from Task #161 Phase 0.2)

Update TaskService to detect and create repository backend, propagate info to task backends:

```typescript
// TaskService enhancement
class TaskService {
  static async createWithEnhancedBackend(options) {
    // 1. Detect repository backend type
    const repoBackendType = detectRepositoryBackend(options.workspacePath);

    // 2. Create repository backend instance
    const repoBackend = await createRepositoryBackend({
      type: repoBackendType,
      workspacePath: options.workspacePath,
    });

    // 3. Validate task backend compatibility
    validateTaskBackendCompatibility(repoBackendType, options.backend);

    // 4. Create task backend with repo info
    const taskBackend = await createTaskBackend({
      ...options,
      repositoryBackend: repoBackend,
    });

    return new TaskService(taskBackend, repoBackend);
  }
}
```

### 3. Task Backend Compatibility Validation (from Task #161 Phase 0.3)

Implement compatibility rules:

```typescript
function validateTaskBackendCompatibility(repoBackend: string, taskBackend: string) {
  if (taskBackend === "github-issues" && repoBackend !== "github") {
    throw new Error(
      "GitHub Issues task backend requires GitHub repository backend. " +
        "Current repository backend: " +
        repoBackend +
        "\n\n" +
        "To use GitHub Issues:\n" +
        "1. Use in a GitHub repository (git remote should be github.com)\n" +
        "2. Or switch to a compatible task backend (markdown, json-file)"
    );
  }
}
```

### 4. Backend-Qualified Task IDs (from Task #356)

Implement the multi-backend task ID system:

**Format**: `backend#id` (e.g., `gh#123`, `md#456`, `json#789`)

**Implementation**:

- ✅ Update task ID parsing to handle qualified IDs
- ✅ Maintain backward compatibility for unqualified IDs
- ✅ Default new tasks to qualified format
- ✅ Update session management to use qualified IDs
- ✅ Update git operations (branch names, commits) to use qualified IDs

**Backward Compatibility Strategy**:

- Unqualified IDs default to current configured backend
- Migration utilities to update existing tasks
- Graceful degradation when backends unavailable

### 5. Session Management Updates

Update session operations to work with repository backend detection:

- ✅ Session creation detects and stores repository backend type
- ✅ Session workspace inherits repository backend configuration
- ✅ Task operations within sessions use qualified IDs
- ✅ PR operations leverage GitHub repository backend when available

## Implementation Plan

### Phase 1: Repository Backend Auto-Detection (4-6 hours)

1. **Implement detection function** with simple string matching
2. **Add unit tests** for various remote URL formats
3. **Integrate with TaskService** creation flow
4. **Add error handling** for invalid/missing remotes

### Phase 2: Task Backend Compatibility System (3-4 hours)

1. **Implement validation function** with clear error messages
2. **Update TaskService** to call validation during creation
3. **Add comprehensive error messages** with troubleshooting steps
4. **Test compatibility matrix** (all backend combinations)

### Phase 3: Backend-Qualified Task IDs (4-5 hours)

1. **Update task ID parsing** to handle `backend#id` format
2. **Implement backward compatibility** for unqualified IDs
3. **Update task creation** to use qualified format by default
4. **Update all task operations** (get, update, delete, list)

### Phase 4: Integration and Testing (2-3 hours)

1. **End-to-end testing** of GitHub Issues workflow
2. **Session integration testing** with repository backend detection
3. **Migration testing** for existing tasks
4. **Performance testing** for auto-detection overhead

## Acceptance Criteria

### Functional Requirements

- [ ] **Auto-Detection**: Repository backend automatically detected from git remote
- [ ] **Compatibility**: GitHub Issues backend works only with GitHub repository backend
- [ ] **Task IDs**: New tasks use backend-qualified IDs (`gh#123`)
- [ ] **Backward Compatibility**: Existing unqualified task IDs continue working
- [ ] **Error Messages**: Clear guidance when incompatible backends detected

### Integration Requirements

- [ ] **TaskService**: Enhanced to handle repository backend detection and validation
- [ ] **Session Management**: Works with auto-detected repository backends
- [ ] **CLI Commands**: All task operations work with qualified IDs
- [ ] **GitHub Integration**: End-to-end GitHub Issues workflow functional

### Quality Requirements

- [ ] **Performance**: Auto-detection adds <100ms overhead
- [ ] **Error Handling**: Graceful degradation when git remotes unavailable
- [ ] **Documentation**: Integration guide for developers
- [ ] **Testing**: Comprehensive test coverage for all backend combinations

## Testing Strategy

### Unit Tests

- Repository backend detection for various URL formats
- Task backend compatibility validation
- Task ID parsing and qualification
- Backward compatibility scenarios

### Integration Tests

- End-to-end GitHub Issues task workflow
- Session creation with repository backend auto-detection
- Migration from unqualified to qualified task IDs
- Cross-backend task operations

### Manual Testing

- GitHub repository workflow (create task → session → PR)
- Local repository fallback behavior
- Mixed backend repository scenarios
- Error message clarity and helpfulness

## Risk Assessment

### High Risk

- **Existing Task Compatibility**: Ensure unqualified task IDs continue working
- **Performance Impact**: Auto-detection must not slow down common operations
- **Error UX**: Users must understand backend compatibility requirements

### Medium Risk

- **Session Migration**: Existing sessions may need repository backend updates
- **Git Remote Variations**: Handle edge cases in remote URL formats
- **Backend Availability**: Graceful handling when backends become unavailable

### Mitigation Strategies

- Comprehensive backward compatibility testing
- Performance benchmarking with large repositories
- User testing of error messages and troubleshooting guides
- Phased rollout with feature flags

## Documentation Requirements

### Developer Documentation

- Repository backend integration architecture
- Task backend compatibility matrix
- Backend-qualified task ID specification
- Migration guide for existing installations

### User Documentation

- Updated GitHub Issues backend guide with auto-detection
- Troubleshooting guide for backend compatibility issues
- Migration instructions for existing users
- Best practices for mixed-backend workflows

## Dependencies

### Prerequisites

- ✅ Task #138: GitHub Issues backend (completed)
- ✅ Task #161: Repository backend specification (completed)
- ✅ Task #356: Multi-backend architecture design (completed)

### Blockers

- None identified - all prerequisite work completed

### Critical Issues Discovered During Implementation

#### Session PR Workflow Architectural Bug

**Problem**: Session PR creation bypasses session layer and goes directly to git layer, violating core session workflow principles.

**Root Cause**: `src/domain/session/commands/pr-command.ts` incorrectly imports and calls `preparePrFromParams` from git layer instead of using session PR operations layer.

**Impact**:
- Session update (merge main → session branch) is skipped entirely
- Merge conflicts are handled on PR branch instead of session branch  
- Users are left stranded on PR branch (`pr/task-name`) after conflicts
- Violates fundamental rule: users should never work directly on PR branches

**Correct Workflow**:
1. Start on session branch (`task-name`)
2. Run session update (merge main → session branch) 
3. If conflicts → resolve on session branch, stay there
4. Only after clean session branch → create PR branch
5. User remains on session branch, never switches to PR branch

**Current Broken Workflow**:
1. Start on session branch ✅
2. Skip session update entirely ❌
3. Create PR branch immediately ❌  
4. Switch to PR branch ❌
5. Try to merge on PR branch ❌
6. Leave user on PR branch with conflicts ❌

**Evidence**: Error message shows `You are currently on branch 'pr/task-md#357' with merge in progress` proving user was switched to PR branch during conflict resolution.

**Fix Required**: Session PR command must use session PR operations layer (which includes proper session update) instead of bypassing to git layer.

**DEEPER ROOT CAUSE DISCOVERED**: Even after fixing session command layer, the git workflow itself has a fundamental flaw:

- `createPreparedMergeCommitPR` in `src/domain/git/prepared-merge-commit-workflow.ts`
- Line 95: Switches TO PR branch 
- Line 105: Attempts merge ON PR branch ← **If conflicts occur, user stranded on PR branch**
- Line 117: Switches back to source branch ← **Never reached if merge fails**

**Core Problem**: Git workflow tries to merge session branch INTO PR branch, putting conflicts on PR branch where users shouldn't work. 

**Required Fix**: Ensure session branch is clean via session update BEFORE creating PR branch. Never attempt merges on PR branch that could fail.

### Follow-up Tasks

- Enhanced repository backend support (GitLab, custom Git servers)
- Advanced multi-backend operations (cross-backend task references)
- Repository backend caching and performance optimization
- Webhook integration for real-time synchronization

## Success Metrics

### Functional Metrics

- 100% backward compatibility for existing unqualified task IDs
- <100ms overhead for repository backend auto-detection
- 0 breaking changes for existing GitHub Issues backend users

### User Experience Metrics

- Clear error messages with actionable troubleshooting steps
- Seamless transition from Task #138 production-ready state
- End-to-end GitHub workflow completable without manual configuration

### Technical Metrics

- 95%+ test coverage for new integration code
- Support for all major Git remote URL formats
- Graceful degradation when repository backends unavailable

## Implementation Notes

### Design Principles (from Task #161)

- **KISS**: Simple, immediate remote detection only
- **Clean Separation**: Repository and task backends remain distinct
- **Session Behavior**: Sessions inherit repository backend from workspace
- **Graceful Degradation**: Fallback behavior when backends unavailable

### Architectural Decisions

- Repository backend detection happens at TaskService creation time
- Task backend compatibility validation occurs before backend instantiation
- Backend-qualified task IDs use consistent `backend#id` format
- Unqualified task IDs resolve to currently configured backend for compatibility

### Performance Considerations

- Repository backend detection cached per TaskService instance
- Git remote checking optimized for common repository layouts
- Lazy loading of repository backend instances when possible
- Minimal overhead for non-GitHub repository workflows
