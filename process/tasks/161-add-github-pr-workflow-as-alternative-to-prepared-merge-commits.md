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

### 1. Repository Backend Integration

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

- **Task #014**: Repository backend support (GitHub backend)
- **Task #138**: GitHub Issues support (GitHub API authentication)
- **Task #025**: Prepared merge commit workflow (existing behavior)
- **Task #144**: Fixed prepared merge commit implementation

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
