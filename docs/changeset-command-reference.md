# Changeset Command Reference

## Overview

Minsky provides a unified changeset abstraction with consistent terminology and functionality. The abstraction is platform-shaped, but **GitHub PRs are the only implemented backend** (mt#2613 removed the speculative GitLab/Bitbucket adapters, which had zero callers).

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

# Show platform capabilities
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

**GitHub is the only implemented changeset backend.** `detectPlatform()` fails fast with a clear error for non-GitHub repositories (mt#2613).

- ✅ Full PR support with reviews, comments, status checks
- ✅ Draft PRs, branch protection, auto-merge
- ✅ Rich metadata via the shared `repository/github-pr-*` layer (single Octokit construction path)

The session-domain prepared-merge-commit workflow (pr/ branches for local git) exists in the session layer and is not a changeset adapter. Adding another platform (GitLab, Bitbucket, etc.) means implementing a new `ChangesetAdapter` and registering its factory; the `ChangesetPlatform` union deliberately retains the other platform identifiers as stable public API for that future.

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
