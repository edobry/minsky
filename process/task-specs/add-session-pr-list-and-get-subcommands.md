# Restructure Session PR Command with Explicit Subcommands

## Problem Statement

The existing `session pr` command creates pull requests directly, but this creates an inconsistent command structure when adding list and get operations. Users need to inspect PR status, review PR content, and manage multiple PRs across sessions, but the current command structure doesn't scale well for multiple operations and lacks consistency with modern CLI patterns.

## Context

The current Minsky CLI provides a `session pr` command that creates pull requests directly. However, this design creates several issues:

1. **Inconsistent Command Structure**: Direct action commands don't scale well when adding multiple operations
2. **Limited PR Visibility**: No way to list PRs associated with sessions
3. **No PR Inspection**: Cannot retrieve PR details, status, or content programmatically  
4. **Non-Standard Pattern**: Modern CLIs use explicit subcommands (e.g., `gh pr create`, `kubectl get pods`)
5. **Future Growth Constraints**: Adding operations like edit, close, merge becomes awkward

This creates friction in PR-based workflows and deviates from established CLI design patterns.

## Objectives

Restructure the `session pr` command to use explicit subcommands (`create`, `list`, `get`) that provide comprehensive PR management capabilities while following modern CLI design patterns and ensuring future extensibility.

## Requirements

### 1. Session PR Create Subcommand

**Command**: `minsky session pr create`

**Functionality**:
- Replace current `minsky session pr` behavior with explicit `create` subcommand
- Maintain all existing parameters and functionality
- Create pull requests for session workflows with same capabilities as before

**Parameters**: (identical to current `session pr` command)
- `--session <name>` (optional): Session name to create PR for
- `--task <id>` / `-t <id>` (optional): Task ID associated with the session
- `--title <title>` (optional): PR title (auto-generated if not provided)
- `--body <body>` (optional): PR description
- `--body-path <path>` (optional): Path to file containing PR description
- `--repo <path>` (optional): Repository path
- `--debug` (optional): Enable debug output

**Behavior**: Identical to current `session pr` command behavior

### 2. Session PR List Subcommand

**Command**: `minsky session pr list`

**Functionality**:
- List all PRs associated with sessions in the current repository
- Display PR status, title, session name, and last updated date
- Support filtering by session name, task ID, or PR status
- Provide both tabular and JSON output formats

**Parameters**:
- `--session <name>` (optional): Filter PRs by specific session name
- `--task <id>` (optional): Filter PRs by specific task ID  
- `--status <status>` (optional): Filter by PR status (open, closed, merged, draft)
- `--json` (optional): Output results in JSON format
- `--verbose` / `-v` (optional): Show detailed PR information

**Output Format** (tabular):
```
SESSION    TASK   PR#    STATUS   TITLE                           UPDATED
feat-auth  #123   #456   open     feat(#123): Add authentication  2 days ago
bug-fix    #124   #457   merged   fix(#124): Fix login bug       1 week ago
```

**Output Format** (JSON):
```json
{
  "pullRequests": [
    {
      "sessionName": "feat-auth",
      "taskId": "123", 
      "prNumber": 456,
      "status": "open",
      "title": "feat(#123): Add authentication",
      "url": "https://github.com/org/repo/pull/456",
      "updatedAt": "2024-01-15T10:30:00Z",
      "branch": "pr/feat-auth"
    }
  ]
}
```

### 3. Session PR Get Subcommand

**Command**: `minsky session pr get [session-name] --task <id>`

**Functionality**:
- Retrieve detailed information about a specific PR
- Use the same identifier pattern as `session get` command
- Support both positional session name and `--task` flag for lookup
- Display PR content, metadata, status, and related session information

**Parameters**:
- `session-name` (positional, optional): Session name to look up PR for
- `--task <id>` / `-t <id>` (optional): Task ID to find associated PR  
- `--json` (optional): Output in JSON format
- `--content` (optional): Include PR description and diff content
- `--repo <path>` (optional): Repository path (for consistency with session get)

**Parameter Resolution** (matching `session get` behavior):
- If positional name provided: Look up PR for that session
- If `--task` provided: Find PR associated with that task ID
- If neither provided: Auto-detect from current session context
- Error if both provided and they conflict

**Output Format** (default):
```
PR #456: feat(#123): Add authentication

Session:     feat-auth
Task:        #123  
Branch:      pr/feat-auth
Status:      open
Created:     2024-01-13T15:20:00Z
Updated:     2024-01-15T10:30:00Z
URL:         https://github.com/org/repo/pull/456

Description:
Implements user authentication system with JWT tokens...

Files Changed: (5)
- src/auth/AuthService.ts
- src/auth/middleware.ts
- tests/auth/AuthService.test.ts
...
```

**Output Format** (JSON):
```json
{
  "pullRequest": {
    "number": 456,
    "title": "feat(#123): Add authentication",
    "sessionName": "feat-auth", 
    "taskId": "123",
    "branch": "pr/feat-auth",
    "status": "open",
    "url": "https://github.com/org/repo/pull/456",
    "createdAt": "2024-01-13T15:20:00Z",
    "updatedAt": "2024-01-15T10:30:00Z",
    "description": "Implements user authentication...",
    "author": "user@example.com",
    "filesChanged": ["src/auth/AuthService.ts", "..."],
    "commits": [
      {
        "sha": "abc123",
        "message": "Add authentication service", 
        "date": "2024-01-13T15:20:00Z"
      }
    ]
  }
}
```

### 4. Command Structure Integration

**Breaking Change**: Restructure `session pr` to use explicit subcommands

**New Command Structure**: 
- `minsky session pr create` (creates PR - replaces bare `session pr`)
- `minsky session pr list` (lists PRs)
- `minsky session pr get [name] --task <id>` (gets specific PR)

**Migration Impact**: 
- **BREAKING**: `minsky session pr` will no longer work directly
- Users must update to `minsky session pr create`
- All existing parameters and functionality preserved in `create` subcommand
- Clean, consistent command structure for future extensions

### 5. Error Handling

**Common Error Scenarios**:
- No PRs found for specified filters
- Session or task ID not found
- Repository not found or not a git repository
- GitHub API rate limiting or authentication issues
- Network connectivity problems

**Error Messages**:
- "No pull requests found for session 'session-name'"
- "No pull request found for task #123"
- "Session 'session-name' not found"
- "Multiple sessions found. Please specify --task or provide session name"

## Implementation Approach

### 1. Command Structure

```typescript
// Restructured session PR command group with explicit subcommands
interface SessionPrCommands {
  create: SessionPrCreateCommand;  // replaces bare `session pr`
  list: SessionPrListCommand;      // new
  get: SessionPrGetCommand;        // new
}
```

### 2. GitHub Integration

**PR Detection Strategy**:
- Use GitHub API to search for PRs with session-specific branch patterns (`pr/{session-name}`)
- Match PRs to sessions using branch naming conventions
- Extract task IDs from PR titles using conventional commit format patterns
- Cache PR metadata for performance

**API Requirements**:
- GitHub API access for PR search and retrieval
- Repository information access
- Branch and commit history access
- Authentication handling (existing GitHub integration)

### 3. Session Context Resolution

**Reuse Existing Patterns**:
- Use same `resolveSessionContextWithFeedback` function as other session commands
- Follow identical parameter precedence rules as `session get`
- Support auto-detection when no parameters provided

### 4. CLI Registration

**Integration Points**:
- **BREAKING**: Replace existing session PR command with subcommand router
- Implement subcommand routing logic for create/list/get operations
- Register parameter schemas for all three subcommands (create/list/get)
- Update CLI customizations to support new command structure
- Remove direct PR creation from base `session pr` command

## Architecture Considerations

### 1. Backend Agnostic Design

**Future Compatibility**:
- Design PR retrieval interface to work with multiple Git hosting providers
- Abstract GitHub-specific logic behind generic PR provider interface  
- Support future GitLab, Bitbucket, or other hosting provider integration

### 2. Caching and Performance

**Performance Optimizations**:
- Cache PR metadata to reduce API calls
- Batch API requests when listing multiple PRs
- Use conditional requests (ETags) to minimize network traffic
- Implement rate limiting awareness and backoff strategies

### 3. Data Consistency

**Session-PR Relationships**:
- Ensure PR-session mappings remain consistent with session updates
- Handle orphaned PRs when sessions are deleted
- Validate session-task-PR relationships for data integrity

## Dependencies

### 1. GitHub API Integration

**Required Components**:
- GitHub API client (likely already exists)
- Authentication handling (existing)
- Error handling and rate limiting (existing)

### 2. Session Command Infrastructure  

**Existing Dependencies**:
- Session context resolution (`resolveSessionContextWithFeedback`)
- Session provider interface (`SessionProviderInterface`)
- Command registration system (CLI factory)

### 3. Schema Validation

**Parameter Schemas**:
- Extend existing session parameter schemas
- Add validation for new optional parameters
- Maintain consistency with existing session command patterns

## Testing Strategy

### 1. Unit Tests

**Test Coverage**:
- Parameter validation and resolution
- PR filtering and search logic
- GitHub API response handling
- Error scenarios and edge cases

### 2. Integration Tests

**Test Scenarios**:
- End-to-end PR list and get workflows
- Session context auto-detection
- GitHub API integration (with mocked responses)
- CLI parameter parsing and output formatting

### 3. Manual Testing

**User Acceptance Testing**:
- Cross-platform CLI behavior
- Real GitHub repository integration
- Performance with large PR sets
- Error handling with network issues

## Acceptance Criteria

### Core Functionality

- [ ] `minsky session pr create` creates PRs with same functionality as old `session pr`
- [ ] `minsky session pr create --task <id>` works with task-based session lookup
- [ ] `minsky session pr create` supports all existing parameters (title, body, body-path, etc.)
- [ ] `minsky session pr list` displays all session-related PRs in tabular format
- [ ] `minsky session pr list --json` outputs PR list in JSON format
- [ ] `minsky session pr list --session <name>` filters PRs by session name
- [ ] `minsky session pr list --task <id>` filters PRs by task ID
- [ ] `minsky session pr list --status <status>` filters PRs by status
- [ ] `minsky session pr get <session-name>` retrieves PR for specific session
- [ ] `minsky session pr get --task <id>` retrieves PR for specific task
- [ ] `minsky session pr get` auto-detects session when run in session workspace
- [ ] `minsky session pr get --json` outputs PR details in JSON format

### Parameter Consistency

- [ ] `session pr create` maintains all existing parameter behavior from old `session pr`
- [ ] `session pr get` uses identical parameter resolution as `session get`
- [ ] Same precedence rules: positional name > --task > auto-detection
- [ ] Same error messages for missing or conflicting parameters
- [ ] `--repo` parameter works consistently across all session commands

### Error Handling

- [ ] Clear error messages when no PRs found
- [ ] Proper handling of GitHub API rate limits
- [ ] Graceful degradation when GitHub is unavailable  
- [ ] Validation errors for invalid session/task references

### Output Quality

- [ ] Tabular output is properly formatted and readable
- [ ] JSON output follows consistent schema structure
- [ ] Timestamps are displayed in human-readable format
- [ ] Long PR titles are properly truncated in tabular view

### Breaking Change Management

- [ ] **BREAKING**: `minsky session pr` no longer works directly
- [ ] Clear error message directing users to `minsky session pr create`
- [ ] All existing parameters work in `minsky session pr create`
- [ ] Functionality identical between old `session pr` and new `session pr create`
- [ ] Help documentation clearly shows new command structure
- [ ] Migration guide provided for updating scripts and workflows

## Future Enhancements

### 1. Interactive PR Management

**Potential Extensions**:
- `minsky session pr edit` - Modify PR title/description
- `minsky session pr status` - Update PR status or labels
- `minsky session pr merge` - Merge PR with proper checks

### 2. Multi-Repository Support

**Cross-Repository Operations**:
- List PRs across multiple repositories
- Support for monorepo PR management
- Cross-repository session workflows

### 3. Advanced Filtering

**Enhanced Search Capabilities**:
- Filter by author, reviewer, or assignee
- Date range filtering for PR creation/update
- Label-based filtering and categorization
- Full-text search in PR content

### 4. Integration Enhancements

**Workflow Integration**:
- Integration with task status updates
- Automatic PR status synchronization
- Notification systems for PR state changes
- CI/CD pipeline status integration 
