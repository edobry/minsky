# GitHub Issues Task Backend Guide

## Overview

The GitHub Issues task backend allows you to use GitHub Issues as your task management system while working with Minsky. Tasks are automatically synchronized between Minsky and GitHub Issues, providing a seamless integration between your development workflow and GitHub's project management features.

## Features

- **Automatic Task Synchronization**: Create, update, and manage tasks that sync with GitHub Issues
- **Status Label Management**: Task statuses are mapped to GitHub issue labels (`minsky:todo`, `minsky:in-progress`, etc.)
- **GitHub Integration**: Leverage GitHub's issue features like assignments, milestones, and comments
- **Team Collaboration**: Share task visibility with team members through GitHub's interface
- **Flexible Authentication**: Support for GitHub Personal Access Tokens and GitHub CLI integration

## Prerequisites

### 1. Repository Backend Requirements

**IMPORTANT**: The GitHub Issues task backend requires a GitHub repository backend. It cannot be used with local repository backends.

This means:

- Your repository must have a GitHub remote URL (e.g., `https://github.com/user/repo.git`)
- You must be working in a repository that's hosted on GitHub
- Session workspaces must be created with GitHub repository backend

### 2. GitHub Authentication

You need a GitHub Personal Access Token with the following permissions:

- `repo` scope (for private repositories)
- `public_repo` scope (for public repositories)

## Setup Instructions

### Step 1: Create GitHub Personal Access Token

1. Go to [GitHub Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give your token a descriptive name (e.g., "Minsky Task Management")
4. Select scopes:
   - ✅ `repo` (Full control of private repositories)
   - ✅ `public_repo` (Access public repositories)
5. Click "Generate token"
6. **Copy the token immediately** (you won't see it again)

### Step 2: Configure Authentication

#### Option A: Environment Variable (Recommended)

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

Add this to your shell profile (`.bashrc`, `.zshrc`, etc.) to persist across sessions.

#### Option B: Environment File

Create a `.env` file in your project root:

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
```

**Note**: Add `.env` to your `.gitignore` to avoid committing tokens to version control.

#### Option C: GitHub CLI Integration

If you have GitHub CLI installed and authenticated:

```bash
gh auth login
```

Minsky will automatically use your GitHub CLI credentials.

### Step 3: Repository Configuration

Configure your repository to use the GitHub Issues backend:

```yaml
# .minsky/config.yaml
version: 1

# Task Backend Configuration
backend: "github-issues"

# SessionDB Configuration
sessiondb:
  backend: "json"
  json:
    baseDir: "~/.local/state/minsky"
```

### Step 4: Verify Setup

Test your configuration:

```bash
# Test GitHub connectivity
minsky github test

# List existing issues (should work if authentication is correct)
minsky tasks list
```

## Usage Examples

### Basic Task Operations

```bash
# Create a new task (creates GitHub issue)
minsky tasks create "Fix login bug"

# List all tasks
minsky tasks list

# Update task status
minsky tasks status set 123 IN-PROGRESS

# Show task details
minsky tasks show 123
```

### Session Workflow

```bash
# Start a session for a GitHub issue
minsky session start task123 --task 123

# Work in the session...

# Create PR
minsky session pr create --title "Fix login bug" --type fix
# Changeset aliases also available:
minsky session changeset create --title "Fix login bug" --type fix
minsky session cs create --title "Fix login bug" --type fix

# Approve and merge
minsky session approve
```

### Advanced Configuration

```yaml
# .minsky/config.yaml
version: 1

backend: "github-issues"

# Custom label configuration (optional)
backendConfig:
  github-issues:
    statusLabels:
      TODO: "minsky:todo"
      IN_PROGRESS: "minsky:in-progress"
      IN_REVIEW: "minsky:in-review"
      DONE: "minsky:done"
      BLOCKED: "minsky:blocked"
      CLOSED: "minsky:closed"

sessiondb:
  backend: "json"
  json:
    baseDir: "~/.local/state/minsky"
```

## Troubleshooting

### Common Issues

#### "GitHub Issues backend requires GitHub repository backend"

**Problem**: Trying to use GitHub Issues backend with a local repository backend.

**Solution**: Ensure your repository has a GitHub remote URL:

```bash
git remote get-url origin
# Should return: https://github.com/user/repo.git (not a local path)
```

#### "Bad credentials" or "401 Unauthorized"

**Problem**: GitHub token is missing, invalid, or lacks required permissions.

**Solutions**:

1. Verify token is set: `echo $GITHUB_TOKEN`
2. Check token permissions include `repo` or `public_repo`
3. Regenerate token if it has expired
4. Ensure token is correctly copied (no extra spaces/characters)

#### "Repository not found" or "404 Not Found"

**Problem**: GitHub token doesn't have access to the repository.

**Solutions**:

1. Verify repository exists and token has access
2. For private repositories, ensure token has `repo` scope
3. Check repository URL format is correct

#### "Rate limit exceeded"

**Problem**: Hit GitHub API rate limits (5,000 requests/hour for authenticated users).

**Solutions**:

1. Wait for rate limit to reset (check `X-RateLimit-Reset` header)
2. Reduce frequency of operations
3. Use GitHub Apps for higher rate limits in organization settings

### Testing Connection

Use the built-in test command to verify your setup:

```bash
# Test GitHub API connectivity
minsky github test

# Show detailed connection information
minsky github status --verbose
```

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
export LOG_LEVEL=debug
minsky tasks list
```

## Best Practices

### Security

- **Never commit tokens** to version control
- **Use environment variables** or secure credential storage
- **Rotate tokens regularly** (GitHub recommends every 90 days)
- **Use minimal required permissions** for tokens

### Team Collaboration

- **Consistent configuration**: Use the same `.minsky/config.yaml` across team members
- **Shared repository access**: Ensure all team members have repository permissions
- **Label conventions**: Agree on status label naming conventions

### Performance

- **Batch operations**: Use bulk operations when possible
- **Cache responses**: GitHub API responses are cached temporarily
- **Monitor rate limits**: Be aware of API usage in automated workflows

## Migration Guide

### From Markdown Backend

If migrating from markdown backend to GitHub Issues:

1. **Export existing tasks**:

   ```bash
   minsky tasks export --format json > tasks-backup.json
   ```

2. **Configure GitHub Issues backend** (follow setup steps above)

3. **Import tasks** (when migration utilities are available):
   ```bash
   minsky tasks import --from markdown --to github-issues
   ```

### Hybrid Workflow

You can use different backends for different repositories:

- **Open source projects**: GitHub Issues backend for public visibility
- **Internal tools**: Markdown backend for simplicity
- **Client projects**: JSON file backend for portability

## Integration with GitHub Features

### Issue Templates

GitHub Issues backend respects repository issue templates when creating new issues through the GitHub web interface.

### Assignees and Labels

- **Assignees**: Set through GitHub interface, synced to Minsky
- **Labels**: Minsky status labels coexist with other GitHub labels
- **Milestones**: GitHub milestones are preserved and displayed

### Project Boards

GitHub Issues created by Minsky can be added to GitHub Project boards and managed through GitHub's project management interface.

## Support

For issues with the GitHub Issues backend:

1. **Check troubleshooting section** above
2. **Enable debug logging** to get detailed error information
3. **Test connectivity** with `minsky github test`
4. **Check GitHub API status** at [githubstatus.com](https://githubstatus.com)
5. **Report bugs** with debug logs and configuration details

## Future Enhancements

Planned features for the GitHub Issues backend:

- **Webhook support** for real-time synchronization
- **GitHub Actions integration** for automated workflows
- **Enhanced project board integration**
- **Custom field mapping** for GitHub issue templates
- **Bulk migration utilities** from other backends
