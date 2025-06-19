# Testing GitHub Issues Task Backend

## Authentication Setup

### Option 1: Personal Access Token (PAT) - Recommended for testing

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `repo` and `issues`
4. Copy the token

### Option 2: GitHub App (Advanced)

More complex setup, better for production use.

## Environment Configuration

Create a `.env` file in your session directory:

```bash
# Required: GitHub token
GITHUB_TOKEN=your_token_here

# Alternative: you can use GH_TOKEN instead
# GH_TOKEN=your_token_here
```

## Testing Commands

1. **Check if backend is available:**

   ```bash
   minsky tasks list --backend github-issues
   ```

2. **Create a test task:**

   ```bash
   minsky tasks create --backend github-issues "Test GitHub integration"
   ```

3. **List GitHub issues as tasks:**

   ```bash
   minsky tasks list --backend github-issues
   ```

4. **Update task status:**
   ```bash
   minsky tasks status set --backend github-issues TASK_ID IN-PROGRESS
   ```

## What happens when you test:

- Issues are created with `minsky:` prefixed labels
- Labels are auto-created if they don't exist
- Repository is auto-detected from git remotes
- Task specs are stored as issue descriptions

## Required GitHub Repository

Make sure you're in a directory with a GitHub remote that you have write access to.
