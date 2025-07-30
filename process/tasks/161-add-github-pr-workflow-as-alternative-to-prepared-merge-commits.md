# Add GitHub PR Workflow as Alternative to Prepared Merge Commits

## Context

Minsky currently implements a "prepared merge commit" workflow (Tasks #025, #144) where:

1. `session pr` creates a PR branch with a prepared merge commit
2. `session approve` fast-forward merges the prepared commit
3. The workflow works entirely with local/remote Git without requiring GitHub platform features

While this workflow is functional and platform-agnostic, many teams prefer the standard GitHub PR workflow that leverages GitHub's native features like:

- GitHub PR UI for code review and discussion
- GitHub's merge strategies (merge commit, squash and merge, rebase and merge)
- Integration with GitHub's project management features
- GitHub Actions CI/CD integration
- Reviewer assignment and approval workflows
- Draft PR support for work-in-progress

This task proposes adding a GitHub PR workflow that automatically selects the appropriate workflow based on the repository backend:

1. **Prepared Merge Commit Workflow**: Used for local/remote Git repositories (platform-agnostic)
2. **GitHub PR Workflow**: Used for GitHub repositories (leverages GitHub platform features)

**CRITICAL DISCOVERY**: During Task #138 implementation, we discovered that repository backends exist but are not integrated into the configuration system. Task backends (like GitHub Issues) are incorrectly parsing git remotes directly instead of receiving repository information from repository backends. This violates the intended architecture where repository backends should provide repository information to task backends.

This architectural gap must be resolved before implementing the PR workflow, as the workflow selection depends on knowing which repository backend is active.

## Requirements

### Phase 0: Repository Backend Integration (FOUNDATIONAL)

**Problem**: Repository backends exist but aren't integrated with the configuration system or task backends. The current GitHub Issues task backend incorrectly parses git remotes directly, violating the intended architecture.

**Solution**: Implement repository backend auto-detection and integration using the KISS principle.

#### 0.1. Repository Backend Auto-Detection

**Simple auto-detection based on immediate git remote URL (no complex chaining):**

```typescript
function detectRepositoryBackend(workdir: string): RepositoryBackendType {
  const remote = execSync('git remote get-url origin', { cwd: workdir });
  
  if (remote.includes('github.com')) return 'github';
  if (remote.includes('gitlab.com')) return 'gitlab';  
  return remote.startsWith('/') ? 'local' : 'remote';
}
```

**Design Rationale**: 
- **KISS Principle**: No complex remote chaining or configuration
- **Follows Git Conventions**: Uses standard `origin` remote
- **Team Consistency**: Same remote = same backend for everyone
- **Natural Workflow**: Follows patterns developers already know

#### 0.2. Repository Backend Integration with Task Services

**Current Problem**:
```typescript
// WRONG: Task backends parsing git remotes directly
githubConfig = getGitHubBackendConfig(backendConfig.workspacePath);
```

**Correct Architecture**:
```typescript
// RIGHT: Task backends getting repo info from repository backends  
repositoryBackend = detectAndCreateRepositoryBackend(workdir);
githubConfig = repositoryBackend.getGitHubInfo();
```

**Implementation**:
1. **TaskService Integration**: TaskService detects repository backend and creates instance
2. **Repository Info Propagation**: Task backends receive repository information from repository backend
3. **Remove Direct Git Parsing**: Eliminate git remote auto-detection from task backends

#### 0.3. Task Backend Compatibility Validation

**Compatibility Matrix**:
- **GitHub Issues Task Backend**: Requires GitHub repository backend
- **Markdown Task Backend**: Compatible with any repository backend
- **JSON File Task Backend**: Compatible with any repository backend

**Validation Logic**:
```typescript
function validateTaskBackendCompatibility(repoBackend: string, taskBackend: string) {
  if (taskBackend === 'github-issues' && repoBackend !== 'github') {
    throw new Error(
      'GitHub Issues task backend requires GitHub repository backend. ' +
      'Current repository backend: ' + repoBackend
    );
  }
}
```

**Session Behavior**: 
- **Existing sessions** with local remotes cannot use GitHub Issues backend (correct behavior)
- **New sessions** created with GitHub repository backend will work with GitHub Issues
- **No migration needed**: Clean separation, no configuration complexity

#### 0.4. Backend Change Handling

**Remote URL Changes**: When repository remote changes (e.g., GitHub→GitLab):
- Repository backend auto-detection updates automatically
- Task backend compatibility re-validated
- **Task Freezing**: Tasks may become read-only when source backend unavailable (see Task #356)
- **Graceful Degradation**: Clear error messages for incompatible combinations

#### 0.5. Repository vs Task Backend Separation

**Clear Architectural Separation**:
- **Repository Backend**: Where code lives (GitHub, GitLab, local)
- **Task Backend**: Where tasks live (GitHub Issues, markdown, JSON)
- **Independence**: Task backend choice independent of repository backend (where compatible)

**Benefits**:
- **Future GitHub Enterprise**: Auto-detects GitHub backend regardless of domain
- **Future GitLab Issues**: GitLab repository backend + GitLab Issues task backend
- **Mixed Workflows**: GitHub repository + local markdown tasks (valid combination)

### 1. Repository Backend Interface Extension

- **Automatic Workflow Selection**: Repository backend determines the appropriate PR workflow
  - **LocalGitBackend/RemoteGitBackend**: Use prepared merge commit workflow
  - **GitHubBackend**: Use GitHub PR workflow
- **Repository Backend Interface**: Extend the repository backend interface to include PR workflow methods
- **No Manual Configuration**: Workflow selection is automatic based on repository type

### 2. Repository Backend Interface Extension

**Add PR workflow methods to RepositoryBackend interface:**

```typescript
interface RepositoryBackend {
  // Existing methods...

  // New PR workflow methods
  createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string
  ): Promise<PRInfo>;
  mergePullRequest(prNumber: number): Promise<MergeInfo>;
}

interface PRInfo {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
}

interface MergeInfo {
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
}
```

**GitHub Backend PR Creation:**

1. **Create GitHub PR**: Create PR directly from feature branch to base branch using GitHub API
2. **Task Status Update**: Update task status to IN-REVIEW
3. **PR Metadata Storage**: Store GitHub PR information in task metadata

**Local/Remote Backend PR Creation:**

1. **Prepared Merge Commit**: Create PR branch with prepared merge commit (existing behavior)
2. **Task Status Update**: Update task status to IN-REVIEW
3. **PR Metadata Storage**: Store prepared merge commit information in task metadata

### 3. Backend-Specific Approval Workflows

**GitHub Backend Approval (`session approve` with GitHub repository):**

1. **Merge via GitHub API**: Use GitHub's default merge strategy
2. **Task Status Update**: Update task status to DONE
3. **Metadata Update**: Store GitHub merge information in task metadata

**Local/Remote Backend Approval (`session approve` with local/remote repository):**

1. **Fast-Forward Merge**: Merge prepared merge commit to main branch (existing behavior)
2. **Push Changes**: Push updated main branch to remote
3. **Branch Cleanup**: Delete PR branch after merge
4. **Task Status Update**: Update task status to DONE
5. **Metadata Update**: Store merge commit information in task metadata

### 4. Enhanced Task Metadata

**Extend task metadata to support both workflows:**

```yaml
---
# Existing prepared merge commit fields
merge_info:
  commit_hash: abc123...
  merge_date: 2023-06-15T14:32:00Z
  merged_by: username

# New GitHub PR fields
github_pr:
  pr_number: 123
  pr_url: https://github.com/org/repo/pull/123
  created_at: 2023-06-15T14:30:00Z
  merged_at: 2023-06-15T14:35:00Z
---
```

### 5. Command Line Interface

**Unified session commands (workflow automatically determined by repository backend):**

```bash
# Works with any repository backend - workflow determined automatically
minsky session pr
minsky session approve

# Local/Remote Git repositories: Uses prepared merge commit workflow
# GitHub repositories: Uses GitHub PR workflow
```

**Standard options available for both backends:**

- `--title`: PR title (for GitHub) or merge commit title (for local/remote)
- `--body`: PR body (for GitHub) or merge commit body (for local/remote)

### 6. Authentication Integration

**Reuse existing GitHub authentication** from Task #138:

- GitHub repositories use existing GitHub API authentication
- No additional authentication setup required
- Leverages existing token management and repository detection

### 7. Backward Compatibility

**Seamless migration:**

- All existing `session pr` and `session approve` commands work unchanged
- Local/Remote Git repositories continue using prepared merge commit workflow
- GitHub repositories automatically use GitHub PR workflow when configured
- No breaking changes to existing functionality
- Existing task metadata format remains compatible

**Automatic behavior:**

- Repositories automatically use the appropriate workflow based on their backend type
- No user action required for migration
- Existing prepared merge workflow preserved for local/remote Git repositories

## Implementation Steps

### Phase 0: Repository Backend Integration (FOUNDATIONAL)

1. **Repository Backend Auto-Detection**: Implement simple remote URL detection (no chaining)
2. **TaskService Integration**: Integrate repository backend detection and instantiation
3. **Task Backend Compatibility**: Add validation for task/repository backend combinations
4. **GitHub Issues Backend Fix**: Remove direct git remote parsing, use repository backend
5. **Session Validation**: Ensure existing sessions error gracefully with incompatible backends

### Phase 1: Repository Backend Interface Extension

1. **Extend RepositoryBackend Interface**: Add PR workflow methods to the base interface
2. **Local/Remote Backend Implementation**: Implement PR methods using existing prepared merge commit logic
3. **GitHub Backend Enhancement**: Add PR creation/merge capabilities to existing GitHub backend (Task #014)
4. **GitHub API Integration**: Implement GitHub REST API client for PR operations

### Phase 2: Session Command Integration

1. **Backend-Aware Commands**: Update session commands to call repository backend PR methods
2. **Unified Interface**: Single `session pr` and `session approve` interface that works with any backend
3. **Option Filtering**: GitHub-specific options only available when using GitHub backend
4. **Task Metadata**: Extend task metadata schema for both workflow types

### Phase 3: Basic Error Handling

1. **GitHub API Errors**: Handle basic GitHub API failures gracefully
2. **Authentication Errors**: Provide clear messages for auth failures
3. **Repository Not Found**: Handle missing repository errors
4. **Basic Validation**: Validate PR titles and ensure branches exist

## Verification

### Phase 0: Repository Backend Integration

- [ ] Repository backend auto-detection works for GitHub, GitLab, local, and remote repositories
- [ ] TaskService creates appropriate repository backend instance based on detection
- [ ] GitHub Issues task backend receives repository info from GitHub repository backend (no direct git parsing)
- [ ] Task backend compatibility validation prevents incompatible combinations
- [ ] Existing sessions with local remotes error gracefully when attempting to use GitHub Issues backend
- [ ] New sessions created with GitHub repository backend work correctly with GitHub Issues task backend
- [ ] Clear error messages provided for all incompatible backend combinations

### Core Functionality

- [ ] GitHub repositories automatically use GitHub PR workflow with `session pr`
- [ ] Local/Remote repositories continue using prepared merge commit workflow with `session pr`
- [ ] Task metadata includes appropriate information for each workflow type
- [ ] GitHub default merge strategy works correctly

### Backend Integration

- [ ] Repository backend interface extended with PR workflow methods
- [ ] GitHub backend implements PR creation and merging via GitHub API
- [ ] Local/Remote backends implement PR methods using existing prepared merge logic
- [ ] Automatic workflow selection based on repository backend type

### Integration and Compatibility

- [ ] Existing prepared merge commit workflow unchanged for local/remote repositories
- [ ] Seamless workflow selection based on repository type
- [ ] GitHub backend integration works with existing authentication
- [ ] Task metadata backward compatibility maintained

### Error Handling

- [ ] Basic GitHub API errors handled gracefully
- [ ] Authentication failures provide clear error messages
- [ ] Repository not found errors handled appropriately

## Dependencies

- **Task #014**: Repository backend support (GitHub backend) - **PARTIALLY COMPLETE**
  - ✅ Repository backend implementations exist
  - ❌ Repository backend configuration integration (addressed in Phase 0)
- **Task #138**: GitHub Issues support (GitHub API authentication) - **COMPLETE WITH ARCHITECTURAL FIX**
  - ✅ GitHub Issues task backend exists
  - ❌ Currently parses git remotes directly (fixed in Phase 0)
- **Task #025**: Prepared merge commit workflow (existing behavior) - **COMPLETE**
- **Task #144**: Fixed prepared merge commit implementation - **COMPLETE**
- **Task #356**: Multi-backend task system architecture (task freezing behavior) - **REFERENCED**

## Benefits

### For Individual Developers

- **Choice**: Select workflow that matches personal preference
- **Platform Integration**: Leverage GitHub's native features when desired
- **Familiar UX**: Use standard GitHub PR workflow many developers know

### For Teams

- **Code Review**: Use GitHub's PR review system
- **CI/CD Integration**: Leverage GitHub Actions on PR events
- **Project Management**: Integrate with GitHub Projects and Issues
- **Visibility**: Team members can see PR status in GitHub UI

### For Organizations

- **Compliance**: Use GitHub's enterprise features for compliance
- **Analytics**: Access GitHub's PR analytics and reporting
- **Integration**: Connect with other GitHub-integrated tools
- **Governance**: Implement branch protection and review requirements

## Notes

This task provides **automatic workflow selection** based on repository type, eliminating the need for manual configuration:

1. **Local/Remote Git repositories** automatically use the prepared merge commit workflow (platform-agnostic)
2. **GitHub repositories** automatically use the GitHub PR workflow (platform-integrated)
3. **Seamless experience** where the same commands work with any repository type

The implementation maintains the session-first, task-oriented approach while automatically leveraging the most appropriate workflow for each repository backend.

### Critical Architectural Foundation (Phase 0)

**Discovery**: During Task #138 implementation, we identified that repository backends exist but are not properly integrated with the configuration system. Task backends were incorrectly parsing git remotes directly instead of receiving repository information from repository backends.

**Design Decisions**:

1. **Simple Auto-Detection (KISS)**: Repository backend determined by immediate git remote URL only
   - No complex chaining or configuration required
   - Follows standard git conventions (origin remote)
   - Natural workflow that developers already understand

2. **Clean Architecture Separation**:
   - **Repository Backend**: Where code lives (GitHub, GitLab, local)
   - **Task Backend**: Where tasks live (GitHub Issues, markdown, JSON)
   - **Compatibility Validation**: Some combinations require specific pairings

3. **Session Behavior**:
   - Existing sessions with local remotes cannot use GitHub Issues (correct behavior)
   - New sessions created with appropriate repository backend enable full functionality
   - No complex migration needed - clean separation principle

4. **Graceful Degradation**:
   - Clear error messages for incompatible backend combinations
   - Task freezing when repository backend changes (see Task #356)
   - Backward compatibility maintained for all existing workflows

This foundational work (Phase 0) is essential before implementing the PR workflow features, as the workflow selection mechanism depends on proper repository backend integration.
