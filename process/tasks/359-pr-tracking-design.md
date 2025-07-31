# Enhanced PR Tracking Design for Task 359

## Overview

Task 359 requires restructuring the `session pr` command into subcommands (`create`, `list`, `get`). This requires enhancing the session record structure to store detailed PR information for the new list and get operations.

## Current Session Record Structure

```typescript
interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github";
  branch?: string;
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string;
    createdAt?: string;
    mergedAt?: string;
  };
}
```

## Limitations of Current Structure

1. **No PR Metadata**: Missing PR number, URL, status, title
2. **No GitHub Integration**: No GitHub-specific information
3. **Limited for Listing**: Cannot support `session pr list` functionality
4. **Missing Details**: No PR description, files changed, commits for `session pr get`

## Proposed Enhanced Structure

### New `pullRequest` Field

Add a new optional `pullRequest` field to SessionRecord:

```typescript
interface SessionRecord {
  // ... existing fields ...
  pullRequest?: {
    // Core PR Information
    number: number;
    url: string;
    title: string;
    state: "open" | "closed" | "merged" | "draft";
    
    // Timestamps
    createdAt: string; // ISO timestamp
    updatedAt: string; // ISO timestamp
    mergedAt?: string; // ISO timestamp when merged
    
    // GitHub-specific information
    github?: {
      id: number; // GitHub PR ID
      nodeId: string; // GitHub GraphQL node ID
      htmlUrl: string; // Web URL
      author: string; // GitHub username
      assignees?: string[]; // GitHub usernames
      reviewers?: string[]; // GitHub usernames
      labels?: string[]; // Label names
      milestone?: string; // Milestone title
    };
    
    // Content information (for pr get command)
    body?: string; // PR description
    commits?: {
      sha: string;
      message: string;
      author: string;
      date: string;
    }[];
    filesChanged?: string[]; // List of file paths
    
    // Branch information
    headBranch: string; // Source branch (e.g., "pr/task359")
    baseBranch: string; // Target branch (e.g., "main")
    
    // Metadata
    lastSynced: string; // When this info was last updated from GitHub API
  };
}
```

## Backward Compatibility Strategy

1. **Keep Existing `prState`**: Maintain existing field for backward compatibility
2. **Optional `pullRequest`**: New field is optional, won't break existing sessions
3. **Migration Path**: Gradually populate `pullRequest` field when PRs are created/updated
4. **Fallback Logic**: Commands can fall back to GitHub API if `pullRequest` data is missing

## Data Population Strategy

### PR Create Command
When `session pr create` is executed:
1. Create PR via GitHub API or git operations
2. Populate basic `pullRequest` information (number, URL, title, state)
3. Store in session record for future list/get operations

### PR List Command
When `session pr list` is executed:
1. Read cached `pullRequest` data from session records
2. Optionally refresh from GitHub API if data is stale
3. Display consolidated view across all sessions

### PR Get Command  
When `session pr get` is executed:
1. Use cached `pullRequest` data if available and recent
2. Fetch detailed information from GitHub API if needed
3. Update session record with latest information

## GitHub API Integration

### Required API Endpoints
- `GET /repos/{owner}/{repo}/pulls` - List PRs for filtering
- `GET /repos/{owner}/{repo}/pulls/{pull_number}` - Get PR details
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits` - Get PR commits
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` - Get changed files

### Caching Strategy
1. **Refresh Threshold**: 5 minutes for PR status, 1 hour for detailed content
2. **Conditional Requests**: Use ETags to minimize API calls
3. **Rate Limiting**: Respect GitHub API rate limits with backoff

## Implementation Plan

### Phase 1: Schema Updates
1. Extend SessionRecord interface with `pullRequest` field
2. Update session database schemas
3. Add migration support for existing sessions

### Phase 2: PR Creation Enhancement
1. Update `session pr create` to populate `pullRequest` field
2. Add GitHub API client for PR creation
3. Store PR metadata in session record

### Phase 3: List/Get Commands
1. Implement `session pr list` with filtering
2. Implement `session pr get` with detailed information
3. Add GitHub API integration for real-time data

### Phase 4: CLI Integration
1. Update command registration to use subcommands
2. Add parameter schemas for new commands  
3. Update help documentation

## Error Handling

### Missing PR Information
- Graceful degradation when `pullRequest` field is missing
- Fallback to GitHub API lookup using branch patterns
- Clear error messages when GitHub API is unavailable

### Authentication Issues
- Handle GitHub API authentication failures
- Provide clear guidance for token setup
- Support both session-level and global GitHub configuration

## Testing Strategy

### Unit Tests
- Session record serialization/deserialization
- PR information caching and refresh logic
- Parameter validation for new subcommands

### Integration Tests
- End-to-end PR workflow with GitHub API
- Session record updates during PR lifecycle
- Cross-session PR listing and filtering

### Manual Testing
- Real GitHub repository integration
- Multiple concurrent sessions with PRs
- Error scenarios (network issues, auth failures) 
