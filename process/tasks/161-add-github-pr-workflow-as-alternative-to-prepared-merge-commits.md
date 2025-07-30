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

## Requirements

### 1. Repository Backend PR Interface Extension

**Migrate existing session PR logic to repository backends:**

- **Current Issue**: Session commands contain PR workflow logic that should be in repository backends
- **Solution**: Move `session pr` and `session approve` logic into repository backend implementations
- **Automatic Workflow Selection**: Repository backend determines the appropriate PR workflow
  - **LocalGitBackend/RemoteGitBackend**: Use prepared merge commit workflow
  - **GitHubBackend**: Use GitHub PR workflow
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
2. **Return PR Information**: Return GitHub PR metadata

**Local/Remote Backend PR Creation:**

1. **Prepared Merge Commit**: Create PR branch with prepared merge commit (existing behavior)
2. **Return PR Information**: Return prepared merge commit metadata

### 3. Backend-Specific Approval Workflows

**GitHub Backend Approval:**

1. **Merge via GitHub API**: Use GitHub's default merge strategy
2. **Return Merge Information**: Return GitHub merge metadata

**Local/Remote Backend Approval:**

1. **Fast-Forward Merge**: Merge prepared merge commit to main branch (existing behavior)
2. **Push Changes**: Push updated main branch to remote
3. **Branch Cleanup**: Delete PR branch after merge
4. **Return Merge Information**: Return merge commit metadata

### 4. Command Line Interface

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

### 5. Command Audit and Migration

**Audit existing commands for repository backend logic:**

- Review all session and git commands for logic that belongs in repository backends
- Migrate appropriate logic from command layer to repository backend layer
- Ensure commands delegate to repository backends rather than implementing Git operations directly

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

**Automatic behavior:**

- Repositories automatically use the appropriate workflow based on their backend type
- No user action required for migration
- Existing prepared merge workflow preserved for local/remote Git repositories

## Implementation Steps

### Phase 1: Repository Backend Interface Extension

1. **Extend RepositoryBackend Interface**: Add PR workflow methods to the base interface
2. **Local/Remote Backend Implementation**: Migrate existing session PR logic to local/remote backends
3. **GitHub Backend Enhancement**: Add PR creation/merge capabilities to existing GitHub backend
4. **GitHub API Integration**: Implement GitHub REST API client for PR operations

### Phase 2: Session Command Migration

1. **Backend-Aware Commands**: Update session commands to delegate to repository backend PR methods
2. **Command Logic Migration**: Move PR workflow logic from session commands to repository backends
3. **Unified Interface**: Single `session pr` and `session approve` interface that works with any backend
4. **Option Filtering**: GitHub-specific options only available when using GitHub backend

### Phase 3: Command Audit and Cleanup

1. **Command Audit**: Review all session and git commands for repository backend logic
2. **Logic Migration**: Move appropriate logic from commands to repository backends
3. **Command Simplification**: Simplify commands to delegate to repository backends
4. **Interface Consistency**: Ensure consistent repository backend interface usage

### Phase 4: Basic Error Handling

1. **GitHub API Errors**: Handle basic GitHub API failures gracefully
2. **Authentication Errors**: Provide clear messages for auth failures
3. **Repository Not Found**: Handle missing repository errors
4. **Basic Validation**: Validate PR titles and ensure branches exist

## Verification

### Core Functionality

- [ ] GitHub repositories automatically use GitHub PR workflow with `session pr`
- [ ] Local/Remote repositories continue using prepared merge commit workflow with `session pr`
- [ ] Repository backend interface extended with PR workflow methods
- [ ] GitHub backend implements PR creation and merging via GitHub API
- [ ] Local/Remote backends implement PR methods using existing prepared merge logic
- [ ] Automatic workflow selection based on repository backend type

### Command Migration

- [ ] Session commands delegate to repository backend PR methods
- [ ] Existing session PR logic migrated to local/remote repository backends
- [ ] Commands simplified to use repository backend interface
- [ ] All Git operations moved to appropriate repository backends

### Integration and Compatibility

- [ ] Existing prepared merge commit workflow unchanged for local/remote repositories
- [ ] Seamless workflow selection based on repository type
- [ ] GitHub backend integration works with existing authentication
- [ ] Backward compatibility maintained for all existing functionality

### Error Handling

- [ ] Basic GitHub API errors handled gracefully
- [ ] Authentication failures provide clear error messages
- [ ] Repository not found errors handled appropriately

## Dependencies

- **Task #014**: Repository backend support (GitHub backend) - **COMPLETE**
- **Task #025**: Prepared merge commit workflow (existing behavior) - **COMPLETE**
- **Task #144**: Fixed prepared merge commit implementation - **COMPLETE**

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

**Key Architectural Principle**: Repository backends encapsulate all repository-specific operations, including PR workflows. Session commands delegate to repository backends rather than implementing Git operations directly.
