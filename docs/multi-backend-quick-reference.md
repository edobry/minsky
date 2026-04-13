# Multi-Backend Quick Reference

## Task ID Formats

| Format    | Example  | Description                       |
| --------- | -------- | --------------------------------- |
| Qualified | `mt#123` | Minsky database backend, task 123 |
| Qualified | `gh#456` | GitHub Issues backend, issue 456  |

## Common Commands

### Task Operations

```bash
# Get task
minsky tasks get mt#123              # Minsky backend
minsky tasks get gh#456              # GitHub backend

# Create task
minsky tasks create "Task title"                    # Default: minsky backend
minsky tasks create --backend gh "GitHub issue"     # GitHub backend

# List tasks
minsky tasks list                    # Default backend only
minsky tasks list --all-backends     # All backends
minsky tasks list --backend gh       # GitHub backend

# Update task status
minsky tasks status mt#123 IN-PROGRESS
minsky tasks status gh#456 DONE
```

### Session Operations

```bash
# Start session
minsky session start mt#123          # Minsky backend task
minsky session start gh#456          # GitHub backend issue

# List sessions
minsky session list
```

### Cross-Backend Operations

```bash
# Search across backends
minsky tasks search "authentication" --backends mt,gh

# Migrate task between backends
minsky tasks migrate-backend --from minsky --to github --execute
```

## Backend Configuration

### Backend Prefixes

| Backend       | Prefix | Example  |
| ------------- | ------ | -------- |
| Minsky DB     | `mt`   | `mt#123` |
| GitHub Issues | `gh`   | `gh#456` |

## Troubleshooting

### Common Issues

```bash
# Task not found
minsky tasks list --backend gh       # Check correct backend

# Backend not configured
minsky config validate               # Check configuration
```

### Validation Commands

```bash
# System health
minsky config validate

# Task resolution
minsky tasks get mt#123 --debug

# Session validation
minsky session validate
```

## Best Practices

### ID Usage

```bash
# Explicit qualified IDs
minsky tasks get mt#123
minsky session start gh#456
```

### Backend Selection

- **`mt#`**: All Minsky-managed tasks (database-backed)
- **`gh#`**: Team collaboration, public issues, external contributions

## Cheat Sheet

### Daily Commands

```bash
# List active work
minsky tasks list --status IN-PROGRESS --all-backends

# Quick session jump
minsky session start $(minsky tasks list --status IN-PROGRESS | head -1 | cut -d' ' -f1)
```

### Status Updates

```bash
# Status update
minsky tasks status mt#123 IN-REVIEW --notes "Ready for review"
```

---

**Tip**: Use qualified IDs (`mt#123`, `gh#456`) for clarity in documentation and commit messages.
