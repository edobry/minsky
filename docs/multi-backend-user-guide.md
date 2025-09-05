# Multi-Backend Task System User Guide

## Overview

The Minsky multi-backend task system allows you to work with tasks from multiple backends (Markdown, GitHub Issues, JSON) simultaneously. This guide covers everything you need to know about using the new system.

## Task ID Formats

### Qualified Task IDs (New Format)

The new system uses **qualified task IDs** that include the backend prefix:

```bash
md#123      # Markdown backend, task 123
gh#456      # GitHub Issues backend, issue 456
json#789    # JSON backend, task 789
```

### Legacy Task IDs (Automatic Migration)

Legacy formats are automatically migrated to the default markdown backend:

```bash
123         → md#123    # Plain number
task#123    → md#123    # Task prefix format
#123        → md#123    # Hash prefix format
```

## Session and Branch Names

### Session Names

```bash
task-md#123     # Session for markdown task 123
task-gh#456     # Session for GitHub issue 456
task-json#789   # Session for JSON task 789
```

### Git Branch Names

```bash
task-md#123     # Git-compatible branch name
task-gh#456     # Same format as session names
```

## CLI Commands

### Working with Qualified Task IDs

All CLI commands now accept qualified task IDs:

```bash
# Get task from specific backend
minsky tasks get md#123
minsky tasks get gh#456

# Update task status
minsky tasks status md#123 IN-PROGRESS

# Create session for qualified task
minsky session start gh#456
```

### Legacy Format Support

Legacy formats continue to work with automatic migration:

```bash
# These all resolve to md#123
minsky tasks get 123
minsky tasks get task#123
minsky tasks get #123

# Automatic migration is logged
# → "Migrated legacy task ID '123' to 'md#123'"
```

### Backend Selection

#### Creating Tasks with Specific Backend

```bash
# Create task in specific backend
minsky tasks create --backend md "Fix bug in parser"
minsky tasks create --backend gh "Add new feature"

# Default backend (markdown) if not specified
minsky tasks create "Update documentation"  # → md#124
```

#### Cross-Backend Operations

```bash
# List tasks from all backends
minsky tasks list --all-backends

# List tasks from specific backends
minsky tasks list --backends md,gh

# Search across multiple backends
minsky tasks search "authentication" --backends md,gh,json
```

## Migration Guide

### Existing Users

If you have existing tasks and sessions, the system automatically handles migration:

1. **Task IDs**: Legacy formats are automatically converted when used
2. **Session Names**: Legacy session names are detected and enhanced
3. **Git Branches**: Existing branches continue to work with auto-detection

### Bulk Session Migration

For existing session databases, use the migration command:

```bash
# Dry run to see what would be migrated
minsky session migrate --dry-run

# Migrate sessions with backup
minsky session migrate --backup

# Migrate specific sessions
minsky session migrate --filter="task123,task456"

# Rollback if needed
minsky session migrate-rollback --backup-id=20240730-123456
```

## Common Workflows

### 1. Working with Markdown Tasks (Default)

```bash
# Create task (defaults to markdown backend)
minsky tasks create "Implement feature X"  # → md#125

# Start session
minsky session start md#125  # or just: minsky session start 125

# Work on task
cd ~/.local/state/minsky/sessions/task-md#125
# ... make changes ...

# Create PR
minsky session pr create --title "Implement feature X" --type feat
# Or using changeset terminology:
minsky session changeset create --title "Implement feature X" --type feat
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
# Or using changeset terminology:
minsky session changeset create --title "Resolve authentication bug" --type fix
```

### 3. Cross-Backend Project Management

```bash
# List all tasks across backends
minsky tasks list --all-backends

# Search for tasks related to authentication
minsky tasks search "auth" --backends md,gh

# Migrate task between backends
minsky tasks migrate md#123 --target-backend gh
```

### 4. Team Collaboration with Mixed Backends

```bash
# Team using both markdown tasks and GitHub issues
minsky tasks list --backends md,gh --status IN-PROGRESS

# Create session for GitHub issue assigned to you
minsky session start gh#456

# Reference multiple task types in commits
git commit -m "feat: Implement auth (md#123, gh#456)"
```

## Best Practices

### 1. Backend Selection

- **Markdown**: Personal tasks, internal documentation, simple project management
- **GitHub Issues**: Public projects, team collaboration, bug tracking with discussions
- **JSON**: Programmatic task management, integration with external systems

### 2. Task ID Usage

- **Use qualified IDs** (`md#123`) in documentation and commit messages for clarity
- **Legacy formats still work** but qualified IDs are more explicit
- **Session names are automatically qualified** so you always know the backend

### 3. Migration Strategy

- **Start using qualified IDs** for new tasks
- **Legacy IDs continue working** with automatic migration
- **Bulk migrate sessions** when convenient, not urgently required

### 4. Git Workflow

- **Branch names are git-compatible** (no colons, uses # which is valid)
- **PR titles should include qualified IDs** for traceability
- **Commit messages benefit from qualified IDs** for cross-backend clarity

## Troubleshooting

### Common Issues

#### Task ID Not Found

```bash
# Error: Task 'xyz#123' not found
# Solution: Check backend is correct and task exists
minsky tasks list --backend xyz
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

### Migration Issues

#### Session Migration Fails

```bash
# Check what would be migrated
minsky session migrate --dry-run --verbose

# Migrate in smaller batches
minsky session migrate --batch-size 10
```

#### Legacy Task ID Conflicts

```bash
# If migration detects conflicts:
minsky tasks list --all-backends | grep "123"  # Check for duplicates
# Manually resolve conflicts before migration
```

## Advanced Features

### Custom Backend Configuration

```bash
# Configure multiple GitHub repositories
minsky init --github-repo primary/repo
minsky init --github-repo secondary/repo --backend-prefix gh2

# Use different backend prefixes
minsky tasks create --backend gh2 "Task in secondary repo"  # → gh2#123
```

### Collision Detection

```bash
# Check for ID conflicts across backends
minsky tasks detect-collisions

# Example output:
# Collision detected: md#123 and gh#123 both exist
# Consider migrating to resolve conflicts
```

### Bulk Operations

```bash
# Migrate multiple tasks
minsky tasks migrate md#100,md#101,md#102 --target-backend gh

# Update status for multiple tasks
minsky tasks status md#123,gh#456 DONE
```

## API and MCP Integration

The multi-backend system works seamlessly across all interfaces:

### MCP Tools

```typescript
// MCP tools automatically support qualified IDs
await mcp.call("tasks.get", { taskId: "md#123" });
await mcp.call("session.start", { taskId: "gh#456" });
```

### API Integration

```typescript
// REST API endpoints accept qualified IDs
GET /api/tasks/md%23123
POST /api/sessions { taskId: "gh#456" }
```

## Future Enhancements

### Planned Features

- **Multiple GitHub repositories** per project
- **Jira backend integration** for enterprise teams
- **Task synchronization** between backends
- **Advanced filtering** and cross-backend queries

### Extensibility

The architecture supports adding new backends:

- Implement `TaskBackend` interface
- Register with `MultiBackendTaskService`
- Choose unique prefix (e.g., `jira#`, `azure#`)

## Getting Help

### Documentation

- Architecture overview: `docs/architecture/multi-backend-task-system-design.md`
- Implementation details: Task #356 specification
- Schema reference: `src/domain/schemas/task-schemas.ts`

### Support Commands

```bash
# Validate current configuration
minsky config validate

# Debug task resolution
minsky tasks get md#123 --debug

# Check schema compatibility
minsky session validate
```

### Community Resources

- GitHub Issues: Use `gh#` prefix for issues related to GitHub backend
- Documentation Tasks: Use `md#` prefix for documentation improvements
- Feature Requests: Create in appropriate backend with clear qualified ID references

---

_This guide covers the multi-backend task system introduced in Task #356. For the latest updates and additional features, check the project changelog and task specifications._
