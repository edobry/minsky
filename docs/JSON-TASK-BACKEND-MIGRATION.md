# JSON Task Backend Migration Guide

## Overview

This guide walks you through migrating from the traditional `tasks.md` file-based task management to the new centralized JSON Task Backend. The migration process is designed to be safe, reversible, and non-destructive.

## Why Migrate?

### Current Limitations with `tasks.md`

- **Synchronization Issues**: Changes in one session/workspace aren't visible in others
- **Conflict Potential**: Multiple workspaces can create conflicting task IDs
- **Limited Querying**: Difficult to filter and search tasks programmatically
- **No State Management**: No metadata tracking for task operations

### Benefits of JSON Backend

- **Centralized Storage**: Single source of truth for all tasks
- **Real-time Sync**: Changes visible across all sessions immediately
- **Enhanced Performance**: Faster querying and filtering
- **Future-Proof**: Easy migration path to SQL databases later
- **Type Safety**: Full TypeScript support with validation

## Pre-Migration Checklist

Before starting the migration:

1. **Backup Current Data**

   ```bash
   # Create a backup of your current tasks
   cp process/tasks.md process/tasks.md.backup
   ```

2. **Ensure Clean State**

   ```bash
   # Make sure all current work is committed
   git status
   git add -A && git commit -m "Backup before JSON backend migration"
   ```

3. **Update Minsky**
   ```bash
   # Ensure you have the latest version with JSON backend support
   minsky --version
   ```

## Migration Process

### Step 1: Export Current Tasks

First, export your current tasks to understand what will be migrated:

```bash
# List current tasks to see what you have
minsky tasks list

# Get detailed view of important tasks
minsky tasks status #123  # Replace with actual task IDs
```

### Step 2: Initialize JSON Backend

Create a new TaskService instance using the JSON backend:

```bash
# Test JSON backend availability
minsky tasks list --backend json-file
```

If you see an error, the JSON backend may need to be enabled in your configuration.

### Step 3: Run Migration Tool

Use the built-in migration utilities:

```typescript
// Example migration script (can be saved as migrate-tasks.js)
import { migrateMarkdownToJson } from "./src/domain/tasks/migration-utils.js";
import { createTaskService } from "./src/domain/tasks/taskService.js";

async function migrate() {
  try {
    // Create services for both backends
    const markdownService = createTaskService({ backend: "markdown" });
    const jsonService = createTaskService({ backend: "json-file" });

    // Get all tasks from markdown
    const tasks = await markdownService.listTasks();
    console.log(`Found ${tasks.length} tasks to migrate`);

    // Migrate each task
    for (const task of tasks) {
      console.log(`Migrating task ${task.id}: ${task.title}`);

      // Create task in JSON backend
      await jsonService.createTask(task.specPath, { force: true });

      // Update status if not TODO
      if (task.status !== "TODO") {
        await jsonService.setTaskStatus(task.id, task.status);
      }
    }

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  }
}

migrate();
```

Run the migration:

```bash
# Run the migration script
bun migrate-tasks.js
```

### Step 4: Verify Migration

Verify that all tasks were migrated correctly:

```bash
# Compare task counts
echo "Markdown backend:"
minsky tasks list --backend markdown | wc -l

echo "JSON backend:"
minsky tasks list --backend json-file | wc -l

# Check specific tasks
minsky tasks list --backend json-file
minsky tasks status #123 --backend json-file
```

### Step 5: Update Default Backend (Optional)

If you want to make JSON the default backend for this project:

```typescript
// In your project configuration or TaskService initialization
const taskService = createTaskService({
  backend: "json-file", // Make this the default
});
```

Or configure it globally in your Minsky settings.

## Verification Steps

### 1. Data Integrity Check

```bash
# Verify all tasks exist
minsky tasks list --backend json-file --status TODO
minsky tasks list --backend json-file --status IN-PROGRESS
minsky tasks list --backend json-file --status IN-REVIEW
minsky tasks list --backend json-file --status DONE

# Check specific high-priority tasks
minsky tasks show #129 --backend json-file
```

### 2. Cross-Session Test

1. Open a new terminal session
2. Navigate to a different workspace
3. Run `minsky tasks list --backend json-file`
4. Verify you see the same tasks

### 3. Synchronization Test

1. In one session: `minsky tasks status set #123 IN-PROGRESS --backend json-file`
2. In another session: `minsky tasks status #123 --backend json-file`
3. Verify the status change is visible

## Rollback Procedure

If you need to rollback the migration:

### Option 1: Restore from Backup

```bash
# Restore original tasks.md
cp process/tasks.md.backup process/tasks.md

# Verify restoration
minsky tasks list --backend markdown
```

### Option 2: Export from JSON Back to Markdown

```typescript
// Reverse migration script (save as rollback-tasks.js)
import { createTaskService } from "./src/domain/tasks/taskService.js";

async function rollback() {
  try {
    const jsonService = createTaskService({ backend: "json-file" });
    const markdownService = createTaskService({ backend: "markdown" });

    // Get all tasks from JSON backend
    const tasks = await jsonService.listTasks();
    console.log(`Rolling back ${tasks.length} tasks to markdown`);

    // Clear current markdown tasks (backup first!)
    // Then recreate from JSON data

    for (const task of tasks) {
      console.log(`Rolling back task ${task.id}: ${task.title}`);
      // Implementation depends on your specific needs
    }

    console.log("Rollback completed!");
  } catch (error) {
    console.error("Rollback failed:", error.message);
  }
}

rollback();
```

## Troubleshooting

### Common Issues

#### "Backend 'json-file' not found"

- Ensure you have the latest Minsky version
- Check that JsonFileTaskBackend is properly imported in TaskService
- Verify your configuration includes the json-file backend

#### "Permission denied" errors

- Check file permissions on the JSON storage directory
- Ensure the storage directory is writable
- On Unix systems: `chmod 755 ~/.local/share/minsky/`

#### "Tasks not syncing between sessions"

- Verify both sessions are using the same JSON file path
- Check for file locking issues
- Restart sessions to clear any cached state

#### "Migration seems incomplete"

- Check the migration logs for specific error messages
- Verify source tasks.md format is compatible
- Run migration verification steps

### Getting Help

If you encounter issues during migration:

1. **Check the logs**: Look for error messages in the migration output
2. **Verify prerequisites**: Ensure all dependencies are installed
3. **Test incrementally**: Migrate a few tasks first before migrating all
4. **Ask for help**: Create an issue with:
   - Your current Minsky version
   - The migration command you ran
   - Any error messages
   - Your current tasks.md file structure

## Post-Migration Best Practices

### 1. Backend Consistency

- Use the same backend (`json-file`) across all sessions
- Update your CLI aliases/scripts to include `--backend json-file`
- Consider setting JSON as the default in your configuration

### 2. Regular Backups

```bash
# Create periodic backups of your JSON database
cp ~/.local/share/minsky/tasks.json ~/.local/share/minsky/tasks.json.backup
```

### 3. Monitoring

- Periodically verify task synchronization across sessions
- Monitor JSON file size growth over time
- Keep an eye on performance with large task datasets

### 4. Team Migration

If working with a team:

- Coordinate migration timing to avoid conflicts
- Share migration scripts and verification steps
- Establish team conventions for the new backend

## Advanced Configuration

### Custom Storage Location

```typescript
// Configure custom JSON storage path
const taskService = createTaskService({
  backend: "json-file",
  // Custom configuration would go here
  workspacePath: "/custom/path/to/storage",
});
```

### Performance Tuning

For large task datasets:

- Consider using pretty printing only for debugging
- Monitor JSON file size and consider archiving old tasks
- Plan for future migration to SQL backend if needed

## Conclusion

The JSON Task Backend migration provides immediate benefits in synchronization and sets up your Minsky installation for future enhancements. The migration is designed to be safe and reversible, but proper planning and verification ensure a smooth transition.

After migration, you'll enjoy:

- ✅ Real-time task synchronization across all sessions
- ✅ Enhanced query and filtering capabilities
- ✅ Better performance for large task sets
- ✅ Future-proof architecture for database upgrades
- ✅ Type-safe task operations

Welcome to the improved Minsky task management experience!
