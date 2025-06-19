# feat(#138): Add GitHub Issues Support as Task Backend

## Summary

This PR implements task #138, adding comprehensive GitHub Issues support as a new task backend for Minsky. Users can now manage tasks directly within GitHub Issues, with automatic label creation, status synchronization, and seamless integration with existing CLI commands.

## Motivation & Context

The original task specification identified the need for GitHub Issues integration to enable team collaboration and leverage GitHub's native issue tracking capabilities. This addresses limitations of file-based task management by providing:

- Centralized task management accessible to entire teams
- Native GitHub integration for development workflows  
- Automatic status tracking via labels
- Real-time collaboration capabilities
- Integration with GitHub's project management features

The implementation follows user-specified configuration decisions around token management, repository auto-detection, and label handling.

## Design Approach

The implementation follows the existing TaskBackend interface pattern, ensuring seamless integration with the current architecture. Key design decisions include:

- **Factory Pattern**: Used runtime `require()` to bypass TypeScript module resolution issues with optional dependencies
- **Auto-Configuration**: Automatic detection of GitHub repository from git remotes and environment variables
- **Label Management**: Automatic creation of Minsky-specific status labels with consistent color coding
- **Error Handling**: Comprehensive error handling for API failures, network issues, and configuration problems
- **Session-First Workflow**: All implementations use absolute paths and follow session workspace conventions

## Key Changes

### Core Backend Implementation

- **GitHubIssuesTaskBackend class** (484 lines): Complete TaskBackend interface implementation
  - GitHub API integration using @octokit/rest
  - Task-to-issue mapping with configurable status labels
  - Auto-detection of GitHub repo from git remotes
  - Automatic label creation with status-based colors
  - Comprehensive error handling for API and network failures

### Configuration System

- **githubBackendConfig.ts**: Environment-based configuration management
  - dotenvx integration for `.env` file loading
  - Auto-detection of GitHub owner/repo from git remote URLs
  - Support for both `GITHUB_TOKEN` and `GH_TOKEN` environment variables
  - Label creation with status-based color coding (TODO=green, IN-PROGRESS=yellow, etc.)

### Service Integration

- **TaskService enhancements**: Added GitHub backend support
  - Async GitHub backend initialization (`initializeGitHubBackend()`)
  - Backend switching capabilities (`switchBackend()`)
  - Auto-configuration when environment variables are available
  - Factory function `createTaskServiceWithGitHub()` for GitHub-enabled services

### Schema Updates

- **CLI command schemas**: Updated all task commands to include `github-issues` as backend option
  - Maintained backward compatibility with existing backends
  - Consistent parameter handling across all commands

### Module Resolution Solution

- **githubBackendFactory.ts**: Factory pattern implementation
  - Runtime `require()` to bypass TypeScript compilation issues
  - Async initialization with proper error handling
  - Absolute path usage for session workspace compatibility

## Code Examples

### GitHub Backend Configuration

<pre><code class="language-typescript">
// Auto-configuration from environment
const config = getGitHubBackendConfig('/path/to/workspace');
// Returns: { githubToken, owner, repo, statusLabels }

// Manual configuration
const backend = createGitHubIssuesTaskBackend({
  name: "github-issues",
  workspacePath: "/workspace",
  githubToken: "ghp_...",
  owner: "org",
  repo: "project"
});
</code></pre>

### TaskService Integration

<pre><code class="language-typescript">
// Create service with GitHub support
const service = await createTaskServiceWithGitHub({
  backend: "github-issues"
});

// Switch backends dynamically
await service.switchBackend("github-issues");
const tasks = await service.listTasks();
</code></pre>

### CLI Usage Examples

    # List GitHub Issues as tasks
    minsky tasks list --backend github-issues
    
    # Create task as GitHub Issue
    minsky tasks create spec.md --backend github-issues
    
    # Update status (creates/updates labels)
    minsky tasks status set #123 IN-PROGRESS --backend github-issues

## Breaking Changes

None. All changes maintain full backward compatibility with existing backends and CLI usage patterns.

## Data Migrations

No data migrations required. The GitHub backend operates independently and existing markdown/JSON task data remains unchanged. Future task #142 will provide migration utilities between backends.

## Ancillary Changes

### Follow-up Tasks Created

- **Task #140**: Import Existing GitHub Issues Under Minsky Management
- **Task #141**: Implement Repository Configuration System  
- **Task #142**: Implement Backend Migration Utility

### Module Import Resolution

- Fixed TypeScript import resolution issues using absolute paths and async factory patterns
- Enhanced error handling throughout the backend initialization process
- Improved session workspace path handling

### UX Issue Resolution

- Identified and created task #139 to fix session context autodetection in `minsky session update`

## Testing

### Comprehensive Test Suite

- **Pure function tests**: 10 tests covering configuration parsing and repository detection
- **Integration tests**: Full GitHub API connectivity and label creation verification
- **Backend switching tests**: Verified seamless transitions between backends
- **Error scenario tests**: Network failures, invalid tokens, missing repositories

### Manual Testing Results

Integration test demonstrated complete functionality:
- GitHub service creation successful
- Available backends: ["markdown", "json-file", "github-issues"]  
- GitHub API connectivity confirmed
- Automatic label creation verified
- Backend switching operational
- 0 tasks listed (no existing issues with Minsky labels)

### Test Coverage

- Configuration auto-detection from git remotes
- Environment variable handling (GITHUB_TOKEN, GH_TOKEN)
- Label creation with proper color coding
- Error handling for various failure scenarios
- Module import resolution using absolute paths

## Screenshots/Examples

### Automatic Label Creation

Default status labels created automatically:
- `minsky:todo` (green) - For TODO status tasks
- `minsky:in-progress` (yellow) - For IN-PROGRESS status tasks  
- `minsky:in-review` (blue) - For IN-REVIEW status tasks
- `minsky:done` (purple) - For DONE status tasks

### Environment Configuration

<pre><code class="language-bash">
# .env file configuration
GITHUB_TOKEN=ghp_your_token_here
# Repository auto-detected from git remote
</code></pre>

### Repository Auto-Detection

Supports both SSH and HTTPS GitHub URLs:
- `git@github.com:owner/repo.git` → `owner/repo`
- `https://github.com/owner/repo.git` → `owner/repo`

## Technical Achievements

- **Complete GitHub Issues integration**: Full TaskBackend interface compliance
- **Zero breaking changes**: Seamless addition to existing architecture
- **Auto-configuration**: Minimal setup required for users
- **Robust error handling**: Comprehensive failure scenario coverage
- **Module resolution**: Solved TypeScript import issues with session workspaces
- **Future-proof design**: Ready for additional GitHub features and team workflows

This implementation provides a solid foundation for GitHub-based task management while maintaining the flexibility and simplicity of the existing Minsky CLI interface. 
