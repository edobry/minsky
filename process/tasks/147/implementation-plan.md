# Task #147: Backend Migration Utility - Implementation Plan

## Minsky Session Edit Pre-Check:
- Session Directory: /Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#147
- Target File (Absolute): /Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#147/process/tasks/147/implementation-plan.md
Proceeding with edit...

## Architecture Analysis

Based on code investigation, the current task backend system:
- Uses functional TaskBackend interface with clear separation of concerns
- TaskService manages multiple backends (markdown, json-file, github-issues)
- Each backend implements: getTasksData(), parseTasks(), formatTasks(), saveTasksData()
- GitHub backend uses Octokit API with label-based status mapping
- JSON backend provides centralized storage across sessions

## Core Components to Implement

### 1. BackendMigrationUtils Class (`src/domain/tasks/migrationUtils.ts`)

```typescript
export class BackendMigrationUtils {
  // Core migration functionality
  async migrateTasksBetweenBackends(sourceBackend, targetBackend, options);

  // Support functions
  async validateMigration(sourceBackend, targetBackend);
  async createBackupBeforeMigration(backend);
  async rollbackMigration(backupData, targetBackend);

  // Status and ID mapping
  mapTaskStatus(status, fromBackend, toBackend, customMapping?);
  resolveIdConflicts(tasks, targetBackend, strategy);

  // Dry run capabilities
  async performDryRun(sourceBackend, targetBackend, options);
}
```

### 2. CLI Integration (`src/adapters/cli/commands/migrate.ts`)

```bash
# Core migration commands
minsky tasks migrate --from markdown --to github-issues
minsky tasks migrate --from json-file --to markdown --dry-run
minsky tasks migrate --from github-issues --to json-file --preserve-ids

# Advanced options
minsky tasks migrate --from markdown --to github-issues \
  --map-status TODO=minsky:todo,DONE=minsky:done \
  --rollback-on-failure \
  --backup-dir ./migration-backup
```

### 3. Migration Configuration System

```typescript
interface MigrationConfig {
  preserveIds: boolean;
  statusMapping: Record<string, string>;
  rollbackOnFailure: boolean;
  createBackup: boolean;
  idConflictStrategy: "skip" | "rename" | "overwrite";
}
```

## Implementation Steps

### Phase 1: Core Migration Infrastructure
1. Create BackendMigrationUtils class with basic structure
2. Implement task data transformation between backends
3. Add ID conflict resolution strategies
4. Create backup/restore functionality

### Phase 2: Status Mapping System
1. Define status mapping between backends:
   - Markdown: TODO, IN-PROGRESS, IN-REVIEW, DONE
   - GitHub Issues: Uses labels (minsky:todo, minsky:in-progress, etc.)
   - JSON File: Same as markdown but centralized storage
2. Implement custom status mapping support
3. Handle edge cases (unknown statuses, missing labels)

### Phase 3: CLI Integration
1. Create migrate command with full option support
2. Add interactive confirmation for destructive operations
3. Implement progress reporting for large migrations
4. Add comprehensive error handling and recovery

### Phase 4: Testing & Validation
1. Unit tests for all migration scenarios
2. Integration tests with actual backend instances
3. Test rollback functionality thoroughly
4. Performance testing with large task sets

## Technical Considerations

### Backend-Specific Challenges

**Markdown → GitHub Issues:**
- Need to create GitHub issues for each task
- Map local task IDs to GitHub issue numbers
- Handle spec file content in issue descriptions
- Manage GitHub API rate limiting

**GitHub Issues → Markdown:**
- Extract task info from issue title/body
- Map GitHub issue numbers to local task IDs
- Create local spec files from issue content
- Handle closed vs open issue states

**JSON File ↔ Others:**
- Centralized vs distributed storage differences
- Session workspace considerations
- Metadata preservation

### Error Recovery Strategies

1. **Atomic Operations**: Ensure migrations are transactional
2. **Backup First**: Always create backups before migration
3. **Validation**: Pre-flight checks for backend availability
4. **Rollback**: Ability to undo failed migrations
5. **Resume**: Handle partial failures and resume capability

## Key Implementation Files

1. `src/domain/tasks/migrationUtils.ts` - Core migration logic
2. `src/adapters/cli/commands/migrate.ts` - CLI command implementation
3. `src/adapters/cli/schemas/migrate.ts` - Command validation schema
4. `src/domain/tasks/__tests__/migrationUtils.test.ts` - Comprehensive tests

## Success Criteria

- [ ] Can migrate tasks between any two supported backends
- [ ] Preserves all task data (title, description, status, metadata)
- [ ] Handles ID conflicts gracefully with multiple strategies
- [ ] Supports custom status mapping between backends
- [ ] Provides dry-run capability for safe testing
- [ ] Implements rollback functionality for failed migrations
- [ ] Includes comprehensive error handling and logging
- [ ] CLI integration with intuitive command structure
- [ ] Full test coverage including integration tests

## Integration with Existing Systems

- Leverages existing TaskService architecture
- Uses established backend factory patterns
- Integrates with existing CLI command structure
- Maintains compatibility with all current backends
- Supports future backend additions without modification 
