# Multi-Backend Quick Reference

## Task ID Formats

| Format | Example | Description |
|--------|---------|-------------|
| Qualified | `md#123` | Markdown backend, task 123 |
| Qualified | `gh#456` | GitHub Issues backend, issue 456 |
| Legacy | `123` | Auto-migrates to `md#123` |
| Legacy | `task#123` | Auto-migrates to `md#123` |

## Common Commands

### Task Operations
```bash
# Get task
minsky tasks get md#123              # Specific backend
minsky tasks get 123                 # Auto-migrates to md#123

# Create task
minsky tasks create "Task title"                    # Default: md backend
minsky tasks create --backend gh "GitHub issue"     # Specific backend

# List tasks
minsky tasks list                    # Default backend only
minsky tasks list --all-backends     # All backends
minsky tasks list --backend gh       # Specific backend
minsky tasks list --backends md,gh   # Multiple backends

# Update task status
minsky tasks status md#123 IN-PROGRESS
minsky tasks status 123 DONE        # Auto-migrates ID
```

### Session Operations
```bash
# Start session
minsky session start md#123          # Qualified ID
minsky session start 123             # Legacy ID (auto-migrates)

# Session paths
~/.local/state/minsky/sessions/task-md#123/    # Qualified session
~/.local/state/minsky/sessions/task123/        # Legacy session (still works)

# List sessions
minsky session list                  # Shows both formats
```

### Cross-Backend Operations
```bash
# Search across backends
minsky tasks search "authentication" --backends md,gh

# Migrate task between backends
minsky tasks migrate md#123 --target-backend gh

# Detect ID conflicts
minsky tasks detect-collisions
```

## Session Migration

### Quick Migration
```bash
# Preview migration
minsky session migrate --dry-run

# Migrate with backup
minsky session migrate --backup

# Rollback if needed
minsky session migrate-rollback --backup-id=<timestamp>
```

### Batch Migration
```bash
# Small batches
minsky session migrate --batch-size 10

# Specific sessions
minsky session migrate --filter="task123,task456"

# Verbose output
minsky session migrate --verbose
```

## Git Integration

### Branch Names
| Session Name | Git Branch | Description |
|--------------|------------|-------------|
| `task-md#123` | `task-md#123` | Git-compatible qualified branch |
| `task123` | `task123` | Legacy branch (still works) |

### PR Workflow
```bash
# Start session
minsky session start gh#456

# Work on code
cd ~/.local/state/minsky/sessions/task-gh#456

# Create PR with qualified reference
minsky session pr --title "fix(gh#456): Authentication bug"
```

## Backend Configuration

### Initialize Backends
```bash
# Markdown (default)
minsky init                          # Markdown backend ready

# GitHub Issues
minsky init --github-repo owner/repo

# Multiple GitHub repos
minsky init --github-repo primary/repo
minsky init --github-repo secondary/repo --backend-prefix gh2
```

### Backend Prefixes
| Backend | Prefix | Example |
|---------|--------|---------|
| Markdown | `md` | `md#123` |
| GitHub Issues | `gh` | `gh#456` |
| JSON | `json` | `json#789` |
| Custom | `custom` | `custom#123` |

## Troubleshooting

### Common Issues
```bash
# Task not found
minsky tasks list --backend gh       # Check correct backend

# Session confusion
minsky session list --verbose        # See all session formats

# Backend not configured
minsky config validate               # Check configuration

# Migration issues
minsky session migrate --dry-run     # Preview before migrating
```

### Validation Commands
```bash
# System health
minsky config validate

# Task resolution
minsky tasks get md#123 --debug

# Session validation
minsky session validate
```

## Legacy Compatibility

### What Still Works
- ✅ `minsky tasks get 123`
- ✅ `minsky session start 123`  
- ✅ Legacy session directories
- ✅ Old git branch names
- ✅ Existing scripts and automation

### What Auto-Migrates
- ✅ `123` → `md#123`
- ✅ `task#123` → `md#123`
- ✅ `#123` → `md#123`
- ✅ Session names enhanced with backend info
- ✅ Git operations detect legacy formats

## Best Practices

### ID Usage
```bash
# ✅ Good: Explicit qualified IDs
minsky tasks get md#123
minsky session start gh#456

# ✅ Also good: Legacy IDs (auto-migrate)
minsky tasks get 123
minsky session start 456

# 📖 Documentation: Use qualified IDs for clarity
# Working on md#123 and gh#456
```

### Team Workflow
```bash
# Team task assignment
minsky tasks create --backend gh "Team feature"     # gh#789

# Individual work
minsky tasks create --backend md "Personal task"    # md#124

# Cross-reference in commits
git commit -m "feat(md#124): Add feature for gh#789"
```

### Backend Selection
- **`md#`**: Personal tasks, documentation, internal work
- **`gh#`**: Team collaboration, public issues, external contributions
- **`json#`**: Programmatic tasks, automation, data processing

## Cheat Sheet

### Daily Commands
```bash
# Create and start working on markdown task
minsky tasks create "Fix bug X" | grep -o 'md#[0-9]*' | xargs minsky session start

# List active work
minsky tasks list --status IN-PROGRESS --all-backends

# Quick session jump
minsky session start $(minsky tasks list --status IN-PROGRESS | head -1 | cut -d' ' -f1)
```

### Status Updates
```bash
# Bulk status updates
minsky tasks status md#123,gh#456,json#789 DONE

# Status with notes
minsky tasks status md#123 IN-REVIEW --notes "Ready for review"
```

### Team Coordination
```bash
# See what everyone is working on
minsky tasks list --status IN-PROGRESS --all-backends --assignee all

# Find tasks needing review
minsky tasks list --status IN-REVIEW --all-backends
```

---

**💡 Tip**: All legacy commands continue working! Start using qualified IDs when convenient, not urgently required.
