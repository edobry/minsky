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

**ARCHITECTURAL FOUNDATION**: During Task #161 implementation, we identified and resolved that repository backends existed but were not integrated into the configuration system. Task backends (like GitHub Issues) were incorrectly parsing git remotes directly instead of receiving repository information from repository backends. This architectural gap was resolved as part of this task, providing the foundation for workflow selection.

## Requirements

### Phase 0: Repository Backend Integration (FOUNDATIONAL) - ✅ COMPLETED

**Problem**: Repository backends exist but aren't integrated with the configuration system or task backends. The current GitHub Issues task backend incorrectly parses git remotes directly, violating the intended architecture.

**Solution**: Implement repository backend auto-detection and integration using the KISS principle.

#### 0.1. Repository Backend Auto-Detection - ✅ COMPLETED

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

#### 0.2. Repository Backend Integration with Task Services - ✅ COMPLETED

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

#### 0.3. Task Backend Compatibility Validation - ✅ COMPLETED

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

#### 0.4. Backend Change Handling - ✅ COMPLETED

**Remote URL Changes**: When repository remote changes (e.g., GitHub→GitLab):
- Repository backend auto-detection updates automatically
- Task backend compatibility re-validated
- **Task Freezing**: Tasks may become read-only when source backend unavailable (see Task #356)
- **Graceful Degradation**: Clear error messages for incompatible combinations

#### 0.5. Repository vs Task Backend Separation - ✅ COMPLETED

**Clear Architectural Separation**:
- **Repository Backend**: Where code lives (GitHub, GitLab, local)
- **Task Backend**: Where tasks live (GitHub Issues, markdown, JSON)
- **Independence**: Task backend choice independent of repository backend (where compatible)

**Benefits**:
- **Future GitHub Enterprise**: Auto-detects GitHub backend regardless of domain
- **Future GitLab Issues**: GitLab repository backend + GitLab Issues task backend
- **Mixed Workflows**: GitHub repository + local markdown tasks (valid combination)

### 1. Repository Backend PR Interface Extension - ✅ COMPLETED

**Migrate existing session PR logic to repository backends:**

- **Current Issue**: Session commands contain PR workflow logic that should be in repository backends
- **Solution**: Move `session pr` and `session approve` logic into repository backend implementations
- **Automatic Workflow Selection**: Repository backend determines the appropriate PR workflow
  - **LocalGitBackend/RemoteGitBackend**: Use prepared merge commit workflow
  - **GitHubBackend**: Use GitHub PR workflow
- **No Manual Configuration**: Workflow selection is automatic based on repository type

### 2. Repository Backend Interface Extension - ✅ COMPLETED

**Add PR workflow methods to RepositoryBackend interface:**

```typescript
interface RepositoryBackend {
  // Existing methods...

  // New PR workflow methods
  createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string,
    session?: string
  ): Promise<PRInfo>;

  mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo>;
}
```

**PR Information Types:**

```typescript
interface PRInfo {
  number: number | string;    // PR number (GitHub) or branch name (local/remote)
  url: string;               // PR URL (GitHub) or branch name (local/remote)
  state: "open" | "closed" | "merged";
  metadata?: any;            // Backend-specific information
}

interface MergeInfo {
  commitHash: string;        // Merge commit hash
  mergeDate: string;         // ISO timestamp
  mergedBy: string;          // User who performed the merge
  metadata?: any;            // Backend-specific information
}
```

### 3. GitHub Backend Implementation - ✅ COMPLETED

**GitHub PR Workflow Implementation:**

```typescript
class GitHubBackend implements RepositoryBackend {
  async createPullRequest(title, body, sourceBranch, baseBranch, session): Promise<PRInfo> {
    // 1. Push source branch to GitHub
    // 2. Create GitHub PR using Octokit API
    // 3. Return PR information
  }

  async mergePullRequest(prNumber, session): Promise<MergeInfo> {
    // 1. Get PR details from GitHub API
    // 2. Merge PR using GitHub's default strategy
    // 3. Return merge information
  }
}
```

**GitHub Integration:**
1. **Authentication**: Use existing GitHub token from environment (`GITHUB_TOKEN` or `GH_TOKEN`)
2. **API Client**: Leverage Octokit for GitHub API operations
3. **PR Creation**: Create real GitHub PRs with proper metadata
4. **PR Merging**: Use GitHub's merge API with conflict detection
5. **Error Handling**: Comprehensive error handling for API failures
6. **Return PR Information**: GitHub PR URL, number, and status

### 4. Local/Remote Backend Implementation - ✅ COMPLETED

**Prepared Merge Commit Workflow Implementation:**

```typescript
class LocalGitBackend implements RepositoryBackend {
  async createPullRequest(title, body, sourceBranch, baseBranch, session): Promise<PRInfo> {
    // 1. Create PR branch from base branch
    // 2. Merge source branch with --no-ff (prepared merge commit)
    // 3. Push PR branch to remote
    // 4. Return PR Information
  }

  async mergePullRequest(prBranch, session): Promise<MergeInfo> {
    // 1. Switch to base branch
    // 2. Fast-forward merge the PR branch
    // 3. Push merged changes
    // 4. Branch Cleanup
    // 5. Return Merge Information
  }
}
```

**Prepared Merge Commit Workflow:**
1. **PR Branch Creation**: Create PR branch from base branch (not source branch)
2. **Prepared Merge Commit**: Merge source branch INTO PR branch with `--no-ff`
3. **Push PR Branch**: Push the prepared merge commit
4. **Fast-Forward Merge**: Later merge the PR branch using fast-forward
5. **Branch Cleanup**: Delete PR branch after merge
6. **Return Merge Information**: Return merge commit metadata

### 5. Command Line Interface - ✅ COMPLETED

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

### 6. Command Audit and Migration - ✅ COMPLETED

**Audit existing commands for repository backend logic:**

- Review all session and git commands for logic that belongs in repository backends
- Migrate appropriate logic from command layer to repository backend layer
- Ensure commands delegate to repository backends rather than implementing Git operations directly

### 7. Authentication Integration - ✅ COMPLETED

**Reuse existing GitHub authentication** from Task #138:

- GitHub repositories use existing GitHub API authentication
- No additional authentication setup required
- Leverages existing token management and repository detection

### 8. Backward Compatibility - ✅ COMPLETED

**Seamless migration:**

- All existing `session pr` and `session approve` commands work unchanged
- Local/Remote Git repositories continue using prepared merge commit workflow
- GitHub repositories automatically use GitHub PR workflow when configured
- No breaking changes to existing functionality

**Automatic behavior:**

- Repositories automatically use the appropriate workflow based on their backend type
- No user action required for migration
- Existing prepared merge workflow preserved for local/remote Git repositories

## Implementation Steps

### Phase 1: Repository Backend Interface Extension - ✅ COMPLETED

1. **Extend RepositoryBackend Interface**: Add PR workflow methods to the base interface
2. **Local/Remote Backend Implementation**: Migrate existing session PR logic to local/remote backends
3. **GitHub Backend Enhancement**: Add PR creation/merge capabilities to existing GitHub backend
4. **GitHub API Integration**: Implement GitHub REST API client for PR operations

### Phase 2: Session Command Migration - ✅ COMPLETED

1. **Backend-Aware Commands**: Update session commands to delegate to repository backend PR methods
2. **Command Logic Migration**: Move PR workflow logic from session commands to repository backends
3. **Unified Interface**: Single `session pr` and `session approve` interface that works with any backend
4. **Option Filtering**: GitHub-specific options only available when using GitHub backend

### Phase 3: Command Audit and Cleanup - ✅ COMPLETED

1. **Command Audit**: Review all session and git commands for repository backend logic
2. **Logic Migration**: Move appropriate logic from commands to repository backends
3. **Command Simplification**: Simplify commands to delegate to repository backends
4. **Interface Consistency**: Ensure consistent repository backend interface usage

### Phase 4: Basic Error Handling - ✅ COMPLETED

1. **GitHub API Errors**: Handle basic GitHub API failures gracefully
2. **Authentication Errors**: Provide clear messages for auth failures
3. **Repository Not Found**: Handle missing repository errors
4. **Basic Validation**: Validate PR titles and ensure branches exist

## Verification

### Phase 0: Repository Backend Integration - ✅ COMPLETED

- [x] Repository backend auto-detection works for GitHub, GitLab, local, and remote repositories
- [x] TaskService creates appropriate repository backend instance based on detection
- [x] GitHub Issues task backend receives repository info from GitHub repository backend (no direct git parsing)
- [x] Task backend compatibility validation prevents incompatible combinations
- [x] Existing sessions with local remotes error gracefully when attempting to use GitHub Issues backend
- [x] New sessions created with GitHub repository backend work correctly with GitHub Issues task backend
- [x] Clear error messages provided for all incompatible backend combinations

### Core Functionality - ✅ COMPLETED

- [x] GitHub repositories automatically use GitHub PR workflow with `session pr`
- [x] Local/Remote repositories continue using prepared merge commit workflow with `session pr`
- [x] Repository backend interface extended with PR workflow methods
- [x] GitHub backend implements PR creation and merging via GitHub API
- [x] Local/Remote backends implement PR methods using existing prepared merge logic
- [x] Automatic workflow selection based on repository backend type

### Command Migration - ✅ COMPLETED

- [x] Session commands delegate to repository backend PR methods
- [x] Existing session PR logic migrated to local/remote repository backends
- [x] Commands simplified to use repository backend interface
- [x] All Git operations moved to appropriate repository backends

### Integration and Compatibility - ✅ COMPLETED

- [x] Existing prepared merge commit workflow unchanged for local/remote repositories
- [x] Seamless workflow selection based on repository type
- [x] GitHub backend integration works with existing authentication
- [x] Backward compatibility maintained for all existing functionality

### Error Handling - ✅ COMPLETED

- [x] Basic GitHub API errors handled gracefully
- [x] Authentication failures provide clear error messages
- [x] Repository not found errors handled appropriately

## Implementation Status

**✅ COMPLETE**: All core functionality implemented and working.

### Completed Work

1. **Repository Backend Interface Extension**: Added `createPullRequest()` and `mergePullRequest()` methods to `RepositoryBackend` interface
2. **Three Backend Implementations**:
   - `LocalGitBackend`: Uses shared prepared merge commit workflow
   - `RemoteGitBackend`: Uses shared prepared merge commit workflow  
   - `GitHubBackend`: Uses GitHub API via Octokit
3. **Shared Workflow Module**: Extracted prepared merge commit logic to `src/domain/git/prepared-merge-commit-workflow.ts`
4. **Repository Backend Auto-Detection**: Added `detectRepositoryBackendType()` and `createRepositoryBackendForSession()`
5. **Session Command Migration**: Updated `session pr` and `session approve` to delegate to repository backends
6. **Testing**: Updated test structure to verify new architecture

### Architecture Benefits Achieved

- **DRY Principle**: Eliminated code duplication between local and remote backends
- **Separation of Concerns**: Repository operations properly encapsulated in backend layer
- **Polymorphic Behavior**: Same interface works with any repository type
- **Auto-Detection**: Workflow automatically selected based on git remote URL
- **Backward Compatibility**: Existing functionality preserved while adding new capabilities

## Dependencies

- **Task #014**: Repository backend support (GitHub backend) - **COMPLETE**
  - ✅ Repository backend implementations exist
  - ✅ Repository backend configuration integration (completed in this task)
- **Task #138**: GitHub Issues support (GitHub API authentication) - **COMPLETE WITH ARCHITECTURAL FIX**
  - ✅ GitHub Issues task backend exists
  - ✅ Repository backend integration (fixed in this task)
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

### Critical Architectural Foundation (Phase 0) - ✅ COMPLETED

**Discovery**: During Task #161 implementation, we identified that repository backends existed but were not properly integrated with the configuration system. Task backends were incorrectly parsing git remotes directly instead of receiving repository information from repository backends.

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

**Key Architectural Principle**: Repository backends encapsulate all repository-specific operations, including PR workflows. Session commands delegate to repository backends rather than implementing Git operations directly.
