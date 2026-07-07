# Changeset Command Reference

## Overview

Minsky provides unified changeset abstraction that works across different VCS platforms (GitHub PRs, GitLab MRs, local git, etc.) with consistent terminology and functionality.

## Command Architecture

### Repository-Wide Operations (VCS Agnostic)

Use `repo changeset` for cross-session analysis and repository-wide changeset operations:

```bash
# List all changesets in repository
minsky repo changeset list [--status open|merged|closed] [--author username] [--limit N]

# Search changesets by query across titles, descriptions, comments
minsky repo changeset search "authentication fix" [--status open] [--author username]

# Get detailed information about any changeset
minsky repo changeset get 154 [--details]

# Show platform capabilities (GitHub features, local git features, etc.)
minsky repo changeset info [--json]

# Filter by specific session
minsky repo changeset list --session task-mt#510
minsky repo changeset search "bug fix" --session my-session
```

### Session-Specific Operations

Use `session pr` for current session workflow (workspace-scoped):

```bash
minsky session pr create --title "Add feature" --type feat [--body "..."] [--bodyPath file.md]
minsky session pr edit --title "Updated title" [--body "..."]
minsky session pr list [--status open]
minsky session pr get [sessionId]
minsky session pr approve [--review-comment "LGTM"]
minsky session pr merge
```

`session pr *` and repo-scoped `repo changeset *` are the canonical command
families. Earlier `session changeset *` / `session cs *` aliases over the same
functionality were retired (mt#2611) — migrate any remaining usages to
`session pr *` above.

## Platform Support

### GitHub

- ✅ Full PR support with reviews, comments, status checks
- ✅ Draft PRs, branch protection, auto-merge
- ✅ GitHub API integration for rich metadata

### Local Git

- ✅ Prepared merge commit workflow (existing)
- ✅ pr/ branch management
- ✅ Session integration with task references

### GitLab (Future)

- 🔄 Merge Requests (MRs) support
- 🔄 GitLab API integration
- 🔄 Pipeline status tracking

### Bitbucket (Future)

- 🔄 Pull Request support
- 🔄 Bitbucket API integration

### Other VCS (Future)

- 🔄 Fossil changesets
- 🔄 Jujutsu changes
- 🔄 Mercurial commits

## Feature Comparison

| Feature           | GitHub | Local Git | GitLab\* | Bitbucket\* |
| ----------------- | ------ | --------- | -------- | ----------- |
| Approval Workflow | ✅     | ✅        | 🔄       | 🔄          |
| Draft Changesets  | ✅     | ❌        | 🔄       | ❌          |
| File Comments     | ✅     | ❌        | 🔄       | ✅          |
| Status Checks     | ✅     | ❌        | 🔄       | ❌          |
| Auto Merge        | ✅     | ✅        | 🔄       | ✅          |

\*Future implementation

## Usage Examples

### Cross-Session Analysis

```bash
# Find all open changesets by specific author
minsky repo changeset list --status open --author alice

# Search for changesets related to authentication
minsky repo changeset search "authentication" --searchComments true

# Get details about any changeset (works across platforms)
minsky repo changeset get 42 --details
```

### Session Workflow

```bash
# Start working on a task
minsky session start --task mt#123

# Create changeset when ready
minsky session pr create --title "Implement feature" --type feat

# List current session's changesets
minsky session pr list

# Approve and merge
minsky session pr approve --review-comment "LGTM"
minsky session pr merge
```

### Platform Information

```bash
# Check what changeset features are available
minsky repo changeset info --json

# Example output:
{
  "platform": "github-pr",
  "features": {
    "approval_workflow": true,
    "draft_changesets": true,
    "file_comments": true,
    "status_checks": true
  }
}
```

## Integration with Existing Workflows

All existing `session pr` commands continue to work without changes. The new changeset commands provide:

1. **Consistent terminology** across VCS platforms
2. **Repository-wide operations** for analysis and search
3. **Platform-agnostic interfaces** for future VCS support
4. **Backward compatibility** with existing session workflows

## MCP Tool Availability

All changeset commands are also available via MCP tools for remote access and integration:

- `changeset_list`, `changeset_search`, `changeset_get`, `changeset_info` (repo-scoped, backend-agnostic)
- `session_pr_create`, `session_pr_approve`, `session_pr_merge`, etc. (workspace-scoped)

This enables programmatic access to changeset operations for automation and integration scenarios.
