# Multi-Backend Task System User Guide

## Overview

The Minsky multi-backend task system allows you to work with tasks from multiple backends (Minsky database, GitHub Issues) simultaneously. This guide covers everything you need to know about using the system.

## Task ID Formats

### Qualified Task IDs

The system uses **qualified task IDs** that include the backend prefix:

```bash
mt#123      # Minsky database backend, task 123
gh#456      # GitHub Issues backend, issue 456
```

## Session and Branch Names

### Session Names

```bash
task-mt#123     # Session for Minsky task 123
task-gh#456     # Session for GitHub issue 456
```

### Git Branch Names

```bash
task-mt#123     # Git-compatible branch name
task-gh#456     # Same format as session names
```

## CLI Commands

### Working with Qualified Task IDs

All CLI commands accept qualified task IDs:

```bash
# Get task from specific backend
minsky tasks get mt#123
minsky tasks get gh#456

# Update task status
minsky tasks status mt#123 IN-PROGRESS

# Create session for qualified task
minsky session start gh#456
```

### Backend Selection

#### Creating Tasks with Specific Backend

```bash
# Create task in specific backend
minsky tasks create --backend minsky "Fix bug in parser"
minsky tasks create --backend github "Add new feature"

# Default backend (minsky) if not specified
minsky tasks create "Update documentation"  # → mt#124
```

#### Cross-Backend Operations

```bash
# List tasks from all backends
minsky tasks list --all-backends

# List tasks from specific backends
minsky tasks list --backends mt,gh

# Search across multiple backends
minsky tasks search "authentication" --backends mt,gh
```

## Common Workflows

### 1. Working with Minsky Tasks (Default)

```bash
# Create task (defaults to minsky backend)
minsky tasks create "Implement feature X"  # → mt#125

# Start session
minsky session start mt#125

# Work on task
cd ~/.local/state/minsky/sessions/task-mt#125
# ... make changes ...

# Create PR
minsky session pr create --title "Implement feature X" --type feat
```

### 2. Working with GitHub Issues

```bash
# List GitHub issues
minsky tasks list --backend gh

# Start session for GitHub issue
minsky session start gh#789

# Work on issue
cd ~/.local/state/minsky/sessions/task-gh#789
# ... make changes ...

# Create PR that references GitHub issue
minsky session pr create --title "Resolve authentication bug" --type fix
```

### 3. Cross-Backend Project Management

```bash
# List all tasks across backends
minsky tasks list --all-backends

# Search for tasks related to authentication
minsky tasks search "auth" --backends mt,gh

# Migrate task between backends
minsky tasks migrate-backend --from minsky --to github --execute
```

## Best Practices

### 1. Backend Selection

- **Minsky database**: All internal tasks, personal work, project management
- **GitHub Issues**: Public projects, team collaboration, bug tracking with discussions

### 2. Task ID Usage

- **Use qualified IDs** (`mt#123`, `gh#456`) in documentation and commit messages for clarity

### 3. Git Workflow

- **Branch names are git-compatible** (uses # which is valid)
- **PR titles should include qualified IDs** for traceability
- **Commit messages benefit from qualified IDs** for cross-backend clarity

## Troubleshooting

### Common Issues

#### Task ID Not Found

```bash
# Error: Task 'xyz#123' not found
# Solution: Check backend is correct and task exists
minsky tasks list --backend mt
```

#### Session Name Confusion

```bash
# If unsure about session format:
minsky session list  # Shows all sessions with qualified names
```

#### Backend Not Available

```bash
# Error: Backend 'gh' not configured
# Solution: Configure GitHub backend first
minsky init --github-repo owner/repo
```

## Advanced Features

### Collision Detection

```bash
# Check for ID conflicts across backends
minsky tasks detect-collisions
```

### Bulk Operations

```bash
# Update status for multiple tasks
minsky tasks status mt#123,gh#456 DONE
```

## API and MCP Integration

The multi-backend system works seamlessly across all interfaces:

### MCP Tools

```typescript
// MCP tools automatically support qualified IDs
await mcp.call("tasks.get", { taskId: "mt#123" });
await mcp.call("session.start", { taskId: "gh#456" });
```

## Getting Help

### Documentation

- Architecture overview: `docs/architecture/multi-backend-task-system-design.md`
- Schema reference: `src/domain/schemas/task-schemas.ts`

### Support Commands

```bash
# Validate current configuration
minsky config validate

# Debug task resolution
minsky tasks get mt#123 --debug

# Check schema compatibility
minsky session validate
```
