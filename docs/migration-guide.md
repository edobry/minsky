# Multi-Backend Migration Guide

## Overview

This guide helps you migrate from the legacy single-backend task system to the new multi-backend architecture introduced in Task #356.

**⚠️ Migration is NOT urgent** - the system provides full backward compatibility with automatic migration.

## What Changed

### Before (Legacy System)

```bash
# Task IDs were simple numbers
minsky tasks get 123
minsky session start 123

# Session names were simple
~/.local/state/minsky/sessions/task123/

# Git branches were simple
git branch task123
```

### After (Multi-Backend System)

```bash
# Task IDs are now qualified with backend prefix
minsky tasks get md#123        # Explicit markdown backend
minsky tasks get gh#456        # GitHub Issues backend

# Legacy IDs still work with auto-migration
minsky tasks get 123           # → Automatically becomes md#123

# Session names are qualified
~/.local/state/minsky/sessions/task-md#123/

# Git branches are qualified but git-compatible
git branch task-md#123
```

## Migration Timeline

### Phase 1: Automatic Compatibility (✅ Complete)

- **Legacy task IDs continue working** with automatic migration
- **Session detection enhanced** to handle both formats
- **Git operations updated** to support qualified names
- **No user action required**

### Phase 2: Enhanced Workflows (✅ Complete)

- **CLI commands accept qualified IDs** for explicit backend selection
- **Cross-backend operations** available (listing, searching)
- **Backend-specific task creation** with `--backend` parameter
- **Optional adoption** - use new features when ready

### Phase 3: Full Migration (📅 When Convenient)

- **Bulk session migration** available for cleaner database
- **Documentation updates** to use qualified IDs
- **Team coordination** for consistent ID formats

## Step-by-Step Migration

### 1. Verify Current System

Check your current tasks and sessions:

```bash
# List all existing tasks
minsky tasks list

# List all sessions
minsky session list

# Check for any issues
minsky config validate
```

### 2. Understand Auto-Migration

Test auto-migration with existing task IDs:

```bash
# These all resolve to md#123 automatically
minsky tasks get 123
minsky tasks get task#123
minsky tasks get #123

# Check the migration message in debug mode
minsky tasks get 123 --debug
# Output: "Migrated legacy task ID '123' to 'md#123'"
```

### 3. Start Using Qualified IDs (Optional)

Begin using qualified IDs for new tasks:

```bash
# Create new task with explicit backend
minsky tasks create --backend md "Update migration guide"  # → md#124

# Start session with qualified ID
minsky session start md#124
```

### 4. Bulk Session Migration (Optional)

When ready, migrate your session database:

```bash
# 1. Preview what would be migrated
minsky session migrate --dry-run

# Example output:
# Sessions to migrate: 15
# task123 → task-md#123
# task456 → task-md#456
# No conflicts detected

# 2. Create backup and migrate
minsky session migrate --backup --batch-size 10

# 3. Verify migration
minsky session list
```

### 5. Update Documentation and Scripts

Update any documentation or scripts that reference task IDs:

```bash
# Before
echo "Working on task 123"
git commit -m "fix: Resolve issue (task#123)"

# After
echo "Working on task md#123"
git commit -m "fix: Resolve issue (md#123)"
```

## Migration Scenarios

### Scenario 1: Individual Developer

**Situation**: Personal project with markdown tasks only

**Migration**:

- ✅ No action required - everything works automatically
- 🎯 Optional: Start using `md#` prefix for new tasks for clarity

```bash
# Continue existing workflow
minsky tasks get 123           # Works automatically

# Or be explicit with new tasks
minsky tasks create --backend md "New feature"  # → md#125
```

### Scenario 2: Team with GitHub Integration

**Situation**: Team wants to integrate GitHub Issues

**Migration**:

1. Configure GitHub backend: `minsky init --github-repo owner/repo`
2. Start using GitHub issues: `minsky tasks list --backend gh`
3. Create sessions for GitHub issues: `minsky session start gh#789`
4. Team adopts qualified IDs for clarity

```bash
# New workflow supports both
minsky tasks list --backends md,gh
minsky session start gh#789
minsky session pr --title "fix(gh#789): Authentication bug"
```

### Scenario 3: Large Project Migration

**Situation**: Many existing tasks and sessions, want clean migration

**Migration**:

1. **Audit current state**
2. **Plan migration window**
3. **Bulk migrate sessions**
4. **Update team documentation**

```bash
# 1. Audit
minsky tasks list > tasks-before-migration.txt
minsky session list > sessions-before-migration.txt

# 2. Migration
minsky session migrate --backup --verbose > migration-log.txt

# 3. Verify
minsky session list > sessions-after-migration.txt
diff sessions-before-migration.txt sessions-after-migration.txt
```

## Common Migration Issues

### Issue 1: Session Name Confusion

**Problem**: Unsure which sessions are migrated

**Solution**: Use the list command to see current format

```bash
minsky session list --verbose
# Shows both legacy and migrated sessions clearly
```

### Issue 2: Git Branch Conflicts

**Problem**: Existing git branches use old format

**Solution**: Both formats work, git operations detect and handle correctly

```bash
# Old branch still works
git checkout task123

# New sessions create qualified branches
minsky session start md#456  # Creates task-md#456 branch
```

### Issue 3: ID Collisions

**Problem**: Same number exists in multiple backends

**Solution**: Use collision detection and resolution

```bash
# Detect collisions
minsky tasks detect-collisions

# Example output:
# Collision: md#123 and gh#123 both exist
# Recommendation: Use qualified IDs to differentiate

# Resolution: Always use qualified IDs for clarity
minsky tasks get md#123  # Markdown task
minsky tasks get gh#123  # GitHub issue
```

### Issue 4: Script Updates

**Problem**: Scripts hardcode legacy task IDs

**Solution**: Update gradually or use auto-migration

```bash
# Scripts continue working with auto-migration
./deploy-script.sh 123  # Auto-migrates to md#123

# Or update scripts to be explicit
./deploy-script.sh md#123  # Explicit backend
```

## Migration Validation

### Pre-Migration Checklist

- [ ] Current system working correctly
- [ ] All team members aware of changes
- [ ] Backup strategy in place
- [ ] Test environment migration completed

### Post-Migration Verification

```bash
# Verify task operations
minsky tasks get md#123
minsky tasks list --all-backends

# Verify session operations
minsky session list
minsky session start md#456

# Verify git operations
cd ~/.local/state/minsky/sessions/task-md#456
git status
```

### Rollback Process

If migration issues occur:

```bash
# 1. Stop using new commands
# 2. Rollback session migration
minsky session migrate-rollback --backup-id=20240730-123456

# 3. Report issue with details
minsky session list > rollback-state.txt
```

## Advanced Migration Topics

### Custom Backend Configuration

```bash
# Multiple GitHub repositories
minsky init --github-repo primary/repo    # Uses 'gh' prefix
minsky init --github-repo team/special --backend-prefix team  # Uses 'team' prefix

# Tasks can target specific backends
minsky tasks create --backend team "Special project task"  # → team#123
```

### Programmatic Migration

For large-scale migrations, use the API:

```typescript
import { SessionMigrationService } from "./domain/session/migration-command";

const migrationService = new SessionMigrationService(sessionDB);

// Migrate with custom filters
const result = await migrationService.migrate({
  dryRun: false,
  createBackup: true,
  filter: ["task123", "task456"],
  batchSize: 50,
});

console.log(`Migrated ${result.successful} sessions`);
```

### Team Migration Coordination

1. **Announce migration timeline** to team
2. **Provide training** on new qualified ID format
3. **Update team documentation** with qualified ID examples
4. **Establish conventions** for backend selection
5. **Monitor migration** progress and issues

## Best Practices After Migration

### 1. Consistent ID Usage

```bash
# Use qualified IDs in team communication
"Working on md#123 and gh#456"

# Use qualified IDs in commit messages
git commit -m "feat(md#123): Add feature X"
```

### 2. Backend Selection Guidelines

- **md#**: Internal tasks, documentation, personal projects
- **gh#**: Public issues, team collaboration, external contributions
- **json#**: Programmatic tasks, automation, integrations

### 3. Documentation Standards

```markdown
# Before

See task 123 for requirements

# After

See task md#123 for requirements
Related GitHub issue: gh#456
```

### 4. Monitoring and Maintenance

```bash
# Regular collision checks
minsky tasks detect-collisions

# Session cleanup
minsky session list --status inactive

# Backend health checks
minsky config validate
```

## Getting Help

### During Migration

- **Test in dry-run mode first**: `--dry-run` flag available for most operations
- **Use verbose logging**: `--verbose` flag shows detailed migration steps
- **Create backups**: `--backup` flag creates restoration points

### After Migration

- **Check task #356**: Complete specification and implementation details
- **Use debug mode**: `--debug` flag shows auto-migration behavior
- **Validate setup**: `minsky config validate` checks system health

### Support Resources

- **Migration logs**: Saved in `~/.local/state/minsky/logs/migration/`
- **Backup files**: Stored in `~/.local/state/minsky/backups/`
- **Configuration**: `~/.local/state/minsky/config.yaml`

---

**Remember**: Migration is designed to be **safe, gradual, and reversible**. The system maintains full backward compatibility, so you can migrate at your own pace.
